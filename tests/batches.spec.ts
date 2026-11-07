/** The Batches queue: one message per Source window, the per-minute limit, and restart recovery; and the Eval merge window. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, type Assessor, type Candidate, type Executor, type Policy, type Thread, type Ticket, type Trigger } from '../src/core/index.ts'
import { Batches } from '../src/app/batches.ts'
import { Effects } from '../src/app/effects.ts'
import { Store } from '../src/app/store.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema } from '../src/policy.ts'

let directory: string
let store: Store
let effects: Effects
let clock: number
let delivered: { requestId: string; text: string }[]
let deliveredEvals: string[]

const trigger = (id: string, source = 'ume'): Trigger => ({ id, source, threads: [{ source, id: `chat-${id}` }], actor: { source, id: 'alice' },
  human: true, at: new Date(clock).toISOString(), text: `message ${id}`, meta: {} })
const candidate = (id: string, source = 'ume'): Candidate => ({ evalId: `eval-${id}`, thread: { key: `${source}:chat-${id}`, ref: { source, id: `chat-${id}` },
  createdAt: '', subscriptions: [], correlated: [], pending: [], meta: {} } as Thread, triggers: [trigger(id, source)], strength: 'inferred',
  policyVersion: 'v1', tickets: [] })
function batches(settings: Record<string, unknown>, paused = () => false): Batches {
  const host = { store, effects, engine: { candidate: (triggerId: string) => candidates.get(triggerId), candidateDelivered: (evalId: string) => { deliveredEvals.push(evalId) } },
    settings: () => SettingsSchema.parse(settings), now: () => clock, paused, candidateCard: async (item: Candidate) => ({ trigger_id: item.triggers[0]!.id }),
    deliver: async (requestId: string, text: string) => { delivered.push({ requestId, text }) } }
  return new Batches(host)
}
const candidates = new Map<string, Candidate>()
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'batches-'))
  store = new Store(join(directory, 'db.sqlite'))
  clock = Date.parse('2026-11-05T00:00:00Z')
  effects = new Effects(store, new HealthBoard(), () => clock)
  effects.start()
  delivered = []
  deliveredEvals = []
  candidates.clear()
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

it('delivers a candidate immediately, as the assessment effect, when its Source has no batch window', async () => {
  const queue = batches({})
  const first = candidate('a')
  candidates.set('a', first)
  queue.request(first)
  expect(effects.pending('assessment', 'eval-a')).toBe(true)
  expect(store.batches.count()).toBe(0)
  await effects.idle()
  // The immediate path is the existing assessment effect, whose handler MasterAssessor owns; no batch row was written.
  expect(delivered).toEqual([])
})

it('delivers a window of candidates as one candidate_batch message, then marks each Eval delivered', async () => {
  const queue = batches({ eval: { batches: { ume: { windowSeconds: 600 } } } })
  for (const id of ['a', 'b']) { const item = candidate(id); candidates.set(id, item); queue.request(item) }
  await effects.idle()
  expect(delivered).toEqual([])
  clock += 600_000
  await effects.idle()
  expect(delivered).toHaveLength(1)
  const message = JSON.parse(delivered[0]!.text) as { kind: string; source: string; window_seconds: number; cards: { trigger_id: string }[] }
  expect(message).toMatchObject({ kind: 'candidate_batch', source: 'ume', window_seconds: 600 })
  expect(message.cards.map(card => card.trigger_id)).toEqual(['a', 'b'])
  expect(delivered[0]!.requestId).toMatch(/^candidate-batch:batch:ume:/)
  expect(deliveredEvals).toEqual(['eval-a', 'eval-b'])
  expect(store.batches.count()).toBe(0)
})

it('splits more candidates than maxBatch into further batches, losing none', async () => {
  const queue = batches({ eval: { batches: { ume: { windowSeconds: 60, maxBatch: 2 } } } })
  for (const id of ['a', 'b', 'c']) { const item = candidate(id); candidates.set(id, item); queue.request(item) }
  clock += 60_000
  await effects.idle()
  expect(delivered).toHaveLength(2)
  expect(delivered.flatMap(item => (JSON.parse(item.text) as { cards: unknown[] }).cards)).toHaveLength(3)
  expect(store.batches.count()).toBe(0)
})

it('defers a batch over maxPerMinute without dropping its candidates', async () => {
  const queue = batches({ eval: { batches: { ume: { windowSeconds: 60, maxBatch: 1, maxPerMinute: 1 } } } })
  for (const id of ['a', 'b']) { const item = candidate(id); candidates.set(id, item); queue.request(item) }
  clock += 60_000
  await effects.idle()
  expect(delivered).toHaveLength(1)
  expect(store.batches.count()).toBe(1)
  clock += 60_000
  await effects.idle()
  expect(delivered).toHaveLength(2)
  expect(store.batches.count()).toBe(0)
})

it('re-enqueues the batches a restart left behind', async () => {
  const first = batches({ eval: { batches: { ume: { windowSeconds: 600 } } } })
  const item = candidate('a')
  candidates.set('a', item)
  first.request(item)
  store.close()
  // A new host opens the same database, as after a restart: the row survives and start() rearms its effect.
  store = new Store(join(directory, 'db.sqlite'))
  effects = new Effects(store, new HealthBoard(), () => clock)
  const queue = batches({ eval: { batches: { ume: { windowSeconds: 600 } } } })
  effects.start()
  queue.start()
  await effects.idle()
  expect(delivered).toEqual([])
  clock += 600_000
  await effects.idle()
  expect(delivered).toHaveLength(1)
})

it('starts an Eval only after the merge window of the newest queued Trigger', () => {
  const repo = new MemoryRepositories()
  const requests: Candidate[] = []
  const assessor: Assessor = { request: (item: Candidate) => { requests.push(item) } }
  const executor: Executor = { start: () => {}, deliver: () => {}, stop: () => {} }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  let now = Date.parse('2026-11-05T00:00:00Z')
  const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 600_000, mergeWindowMs: source => source === 'ume' ? 10_000 : 0,
    gate: () => ({ admissible: true, strength: 'inferred', basis: { via: 'followup' } }), revalidate: () => true, admitsInferred: () => false }
  const engine = new Engine({ repo, scope: { scope: () => ({ listened: true, observed: true }) }, policy: () => policy, assessor, executor, outbox,
    now: () => new Date(now).toISOString() })
  engine.receive(trigger('a'))
  engine.evaluateDue()
  expect(requests).toHaveLength(0)
  now += 10_000
  engine.evaluateDue()
  expect(requests).toHaveLength(1)
  expect(requests[0]!.triggers.map(item => item.id)).toEqual(['a'])
})

it('accepts a self-authenticated Source trigger directly, without an Eval, and returns the same Decision on a repeat', () => {
  const repo = new MemoryRepositories()
  const assessor: Assessor = { request: vi.fn() }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 600_000,
    gate: () => { throw new Error('the gate must not judge a self-authenticated Source request') }, revalidate: () => true, admitsInferred: () => false }
  const engine = new Engine({ repo, scope: { scope: () => ({ listened: true, observed: false }) }, policy: () => policy, assessor,
    executor: { start: () => {}, deliver: () => {}, stop: () => {} }, outbox })
  const source = trigger('q1', 'bqa')
  const first = engine.acceptSourceTrigger(source, { title: 'Question', scope: 'Question', taskType: 'consult' })
  expect(first.result).toBe('stored')
  expect(first.decision?.ticketId).toBeDefined()
  const ticket = repo.tickets.get(first.decision!.ticketId!) as Ticket
  expect(ticket.mandate.strength).toBe('explicit')
  expect(ticket.origin.triggerId).toBe('q1')
  // The ticket's Execution reads the Source-declared task type from the stored Trigger.
  expect(repo.triggers.get('q1')?.taskType).toBe('consult')
  const repeat = engine.acceptSourceTrigger(source, { title: 'Question', scope: 'Question', taskType: 'consult' })
  expect(repeat.result).toBe('duplicate')
  expect(repeat.decision?.id).toBe(first.decision?.id)
})
