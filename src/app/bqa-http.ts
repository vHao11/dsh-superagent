/** Loopback-only BQA inbound endpoints: authenticated question submission, ticket stops, and health. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { Decision, Engine } from '../core/index.ts'
import { KV } from '../kv.ts'
import { BqaConfigSchema, BqaQuestionSchema, bqaTitle, bqaTrigger, type BqaConfig, type BqaQuestion } from '../sources/bqa.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { failure, json, readBody, RouteError } from './http.ts'
import type { Store } from './store.ts'

/** Host dependencies of the BQA inbound routes. */
export interface BqaHttpHost {
  readonly store: Store
  readonly sources: Pick<SourceRegistry, 'instance'>
  readonly engine: Pick<Engine, 'acceptSourceTrigger' | 'receive' | 'stopTicket'>
  /** Resolves once startup finishes or setup determines what is still missing. */
  readonly ready: Promise<void>
  requestPass(): void
}
/** The question response the BQA service expects; `ticketId` is null when the Source only produces candidates. */
interface QuestionAnswer { triggerId: string; ticketId: string | null; duplicate: boolean }
const loopback = (req: IncomingMessage): boolean => {
  const address = req.socket.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}
/** Whether the request carries the shared secret of `BQA_SHARED_SECRET`; a missing secret on either side refuses everything. */
function secretMatches(req: IncomingMessage): boolean {
  const secret = process.env.BQA_SHARED_SECRET
  const given = req.headers['x-bqa-secret']
  if (!secret || typeof given !== 'string') return false
  const a = Buffer.from(given), b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}
/** Reloads the configured BQA instance, which must be installed, enabled, and valid. */
function bqaConfig(host: BqaHttpHost): BqaConfig {
  const instance = host.sources.instance<BqaConfig>('bqa')
  if (!instance?.enabled) throw new RouteError(409, 'The bqa Source is off or not installed')
  return BqaConfigSchema.parse(instance.config)
}
/** Finds the ticket a repeated Trigger already produced, if any. */
function producedTicket(host: BqaHttpHost, decision: Decision | undefined): string | undefined {
  return decision?.ticketId ?? (decision?.id ? host.store.decisions.get(decision.id)?.ticketId : undefined)
}
/**
 * The scope of a BQA ticket: the question plus the requestId the worker must pass unchanged to the retrieval gateway
 * (`POST /api/internal/retrieval/<tool>`), because the gateway binds every search to the requesting run by that id.
 */
export function bqaScope(input: BqaQuestion): string {
  return `${input.question.slice(0, 1500)}\n\nBQA 检索参数：requestId=${input.requestId}。使用 bqa-search.cmd 检索时把该 requestId 原样传入；本行不要写入答案正文。`
}

/**
 * Registers `/bqa/api/*`: the BQA service pushes questions here and stops tickets here, on loopback with the shared secret.
 * The answer callback and health check are the only other routes; the BQA frontend never calls into this plugin.
 */
export function registerBqaHttp(ctx: Context, host: BqaHttpHost): () => void {
  const table = {
    'POST questions': async (body: unknown): Promise<QuestionAnswer> => {
      const input: BqaQuestion = BqaQuestionSchema.parse(body)
      const config = bqaConfig(host)
      const prior = host.store.get(KV.bqa.request(input.requestId))
      if (prior) {
        if (prior.question !== input.question) throw new RouteError(409, 'This requestId was already used for a different question')
        return { triggerId: prior.triggerId, ticketId: prior.ticketId ?? null, duplicate: true }
      }
      const trigger = bqaTrigger(input, config)
      let decision: Decision | undefined
      let duplicate = false
      // A continuous conversation reuses the host Ticket the Trigger continued; only the first question of a window creates one.
      let ticketId: string | undefined
      if (config.autoAccept === 'explicit') {
        const accepted = host.engine.acceptSourceTrigger(trigger, { title: bqaTitle(input.question), scope: bqaScope(input),
          taskType: config.taskType })
        decision = accepted.decision
        duplicate = accepted.result === 'duplicate'
        ticketId = accepted.ticketId
      } else {
        const result = host.engine.receive(trigger)
        duplicate = result === 'duplicate'
        const decisionId = host.store.triggers.disposition(trigger.id)?.decisionId
        decision = decisionId ? host.store.decisions.get(decisionId) : undefined
      }
      ticketId ??= producedTicket(host, decision)
      host.store.set(KV.bqa.request(input.requestId), { triggerId: trigger.id, ...ticketId ? { ticketId } : {}, question: input.question,
        at: new Date().toISOString() })
      host.requestPass()
      return { triggerId: trigger.id, ticketId: ticketId ?? null, duplicate }
    },
    'POST tickets/:id/stop': async (_body: unknown, params: Record<string, string>): Promise<{ stopped: true }> => {
      const id = params.id!
      const ticket = host.store.tickets.get(id)
      if (!ticket) throw new RouteError(404, 'Ticket not found')
      if (ticket.ended) throw new RouteError(409, 'The ticket already ended')
      try { host.engine.stopTicket(id) } catch (error) { throw new RouteError(409, String(error)) }
      return { stopped: true }
    },
    'GET health': async (): Promise<{ state: 'ready' | 'error'; detail: string }> => {
      const instance = host.sources.instance<BqaConfig>('bqa')
      if (!instance?.enabled) return { state: 'error', detail: 'The bqa Source is off or not installed' }
      if (!process.env.BQA_SHARED_SECRET) return { state: 'error', detail: 'BQA_SHARED_SECRET is not set' }
      return { state: 'ready', detail: 'The bqa Source accepts questions' }
    },
  }
  return ctx.webServer.register({ kind: 'prefix', path: '/bqa', handler: async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith('/bqa/api/')) { res.writeHead(404); res.end(); return }
    if (!loopback(req)) { json(res, 403, { error: 'Loopback request required' }); return }
    const segments = url.pathname.slice('/bqa/api/'.length).split('/')
    const route = Object.entries(table).find(([key]) => {
      const [verb, path] = key.split(' ') as [string, string]
      const pattern = path.split('/')
      return verb === (req.method ?? 'GET') && pattern.length === segments.length && pattern.every((part, index) => part.startsWith(':') || part === segments[index])
    })
    // Health is loopback-only; every other route also needs the shared secret.
    if (route?.[0] !== 'GET health' && !secretMatches(req)) { json(res, 403, { error: 'A valid x-bqa-secret header is required' }); return }
    try {
      await host.ready
      if (!route) throw new RouteError(404, 'Unknown operation')
      const params: Record<string, string> = {}
      const pattern = route[0].split(' ')[1]!.split('/')
      pattern.forEach((part, index) => { if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(segments[index]!) })
      const body = req.method === 'POST' ? await readBody(req, 64 * 1024) : undefined
      json(res, 200, await (route[1] as (body: unknown, params: Record<string, string>) => Promise<unknown>)(body, params))
    } catch (error) {
      json(res, ...failure(error))
    }
  } })
}
