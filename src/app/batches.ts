/** Durable per-Source candidate batching: a window's candidates reach the main Session as one message, under a per-minute rate limit. */
import type { Candidate, EngineForMainSession } from '../core/index.ts'
import { KV } from '../kv.ts'
import { evalBatch, type Settings } from '../policy.ts'
import type { Effects } from './effects.ts'
import type { Store } from './store.ts'

/** How long a rate-limited Source waits before trying its waiting candidates again. */
const RATE_RETRY_MS = 2_000

/** Host dependencies of the batch queue. */
export interface BatchHost {
  readonly store: Store
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  readonly engine: Pick<EngineForMainSession, 'candidate' | 'candidateDelivered'>
  settings(): Settings
  /** The clock the effect queue schedules by; defaults to the wall clock, and tests inject one. */
  now?(): number
  /** Whether processing is paused, which holds batch deliveries. */
  paused(): boolean
  /** Builds one candidate's card, exactly as a single candidate message carries it. */
  candidateCard(candidate: Candidate): Promise<Record<string, unknown>>
  /** Delivers one message to the main Session once per request ID, resolving after the Session receives it. */
  deliver(requestId: string, text: string): Promise<void>
}

/**
 * Batches a Source's candidates into one main-Session message after `windowSeconds`, so a burst of N candidates costs one
 * delivery instead of N. Candidates are persisted in the store's `batch` table first, so a restart loses none; a Source
 * without batch settings keeps the immediate single-candidate delivery. Rate limits defer batches without dropping them.
 */
export class Batches {
  /** Registers the handler that flushes one Source's due candidates, assembling their cards into a `candidate_batch` message. */
  constructor(private readonly host: BatchHost) {
    host.effects.handle('assessment-batch', (_payload, source) => this.flush(source), { limit: () => host.paused() ? 0 : 2 })
  }
  /**
   * Queues `candidate` for delivery: immediately as a single candidate when its Source has no batch window, else into the
   * durable batch table, with the batch effect due when its window ends.
   */
  request(candidate: Candidate): void {
    const trigger = candidate.triggers[0]
    const source = trigger?.source ?? ''
    const config = evalBatch(this.host.settings(), source)
    if (!trigger || !config?.windowSeconds) {
      if (trigger) this.host.effects.enqueue('assessment', candidate.evalId, { triggerId: trigger.id })
      return
    }
    const now = this.now()
    const dueAt = now + config.windowSeconds * 1000
    const { store, effects } = this.host
    store.atomic(() => {
      store.batches.add({ evalId: candidate.evalId, triggerId: trigger.id, source, dueAt, createdAt: new Date(now).toISOString() })
      effects.enqueue('assessment-batch', source, { source }, dueAt)
    })
  }
  /** Re-enqueues the batches persisted before a restart (or while the queue was held), due as they were. */
  start(): void {
    for (const { source, dueAt } of this.host.store.batches.sources()) this.host.effects.enqueue('assessment-batch', source, { source }, dueAt)
  }
  /** The clock the effect queue schedules by, which tests inject. */
  private now(): number { return this.host.now?.() ?? Date.now() }
  /** Delivers one Source's due candidates as one message; rate-limited batches are rescheduled and leftover candidates rearmed. */
  private async flush(source: string): Promise<void> {
    const { store, effects, engine } = this.host
    const config = evalBatch(this.host.settings(), source)
    // Batch settings were removed while candidates waited: deliver each one as its own candidate, as before batching.
    if (!config?.windowSeconds) {
      for (const row of store.batches.all(source)) {
        effects.enqueue('assessment', row.evalId, { triggerId: row.triggerId })
        store.batches.remove([row.evalId])
      }
      return
    }
    const now = this.now()
    const rows = store.batches.due(source, now, config.maxBatch)
    if (!rows.length) { this.rearm(source); return }
    const wait = this.rateWait(source, config.maxPerMinute, now)
    if (wait > 0) { effects.enqueue('assessment-batch', source, { source }, wait); return }
    const cards: Record<string, unknown>[] = []
    const handled: string[] = []
    for (const row of rows) {
      const candidate = engine.candidate(row.triggerId)
      // A candidate whose Eval finished or was replaced while it waited is dropped, not delivered.
      if (!candidate || candidate.evalId !== row.evalId) { handled.push(row.evalId); continue }
      cards.push(await this.host.candidateCard(candidate))
      handled.push(row.evalId)
    }
    if (cards.length) {
      const batchId = `batch:${source}:${new Date(rows[0]!.dueAt).toISOString()}`
      await this.host.deliver(`candidate-batch:${batchId}`, JSON.stringify({ kind: 'candidate_batch', batch_id: batchId, source,
        delivered_at: new Date(now).toISOString(), window_seconds: config.windowSeconds, cards }))
      for (const evalId of handled) engine.candidateDelivered(evalId)
      this.record(source, now)
    }
    store.batches.remove(handled)
    this.rearm(source)
  }
  /** Schedules the Source's next waiting batch, if any, at its due time or the retry delay. */
  private rearm(source: string): void {
    const next = this.host.store.batches.next(source)
    if (next) this.host.effects.enqueue('assessment-batch', source, { source }, Math.max(this.now(), next.dueAt))
  }
  /** Returns 0 when `source` may deliver a batch now, else the epoch ms when its oldest delivery leaves the rate window. */
  private rateWait(source: string, maxPerMinute: number, now: number): number {
    const { store } = this.host
    const key = KV.batches.delivered(source)
    const times = (store.get(key) ?? []).filter(at => now - at < 60_000)
    store.set(key, times)
    return times.length < maxPerMinute ? 0 : Math.max(now + RATE_RETRY_MS, times[0]! + 60_000)
  }
  /** Records one delivery of `source`, keeping only the last minute of them. */
  private record(source: string, now: number): void {
    const { store } = this.host
    const key = KV.batches.delivered(source)
    store.set(key, [...(store.get(key) ?? []).filter(at => now - at < 60_000), now])
  }
}