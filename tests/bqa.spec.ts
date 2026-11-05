/** The BQA Source: question Triggers, the authenticated inbound routes, the direct reply and the answer callback. */
import type { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Decision, RetrievalCall, Ticket, TokenUsage, WorkerReport } from '../src/core/index.ts'
import type { Store } from '../src/app/store.ts'
import { Store as StoreClass } from '../src/app/store.ts'
import { registerBqaHttp, type BqaHttpHost } from '../src/app/bqa-http.ts'
import { bqaDirectReply } from '../src/app/bqa-reply.ts'
import { KV } from '../src/kv.ts'
import { BqaConfigSchema, BqaQuestionSchema, bqaToolCalls, bqaTrigger, bqaUsage, sendBqa } from '../src/sources/bqa.ts'

const SECRET = 'test-secret'
let directory: string
let store: Store
let instance: { enabled: boolean; config: ReturnType<typeof BqaConfigSchema.parse> }
const question = { requestId: 'req-1', conversationId: 'conv-1', userId: 'user-1', userName: 'Ann', question: 'How does it work?',
  releaseId: 'release-1', mode: 'qa' as const }
const accepted: Decision = { id: 'decision-1', evalId: 'eval-1', threadKey: 'bqa:conv-1', triggerIds: ['trigger-1'], policyVersion: 'v1',
  at: '2026-11-05T00:00:00.000Z', kind: 'accept', reason: [], strength: 'explicit', ticketId: 'ticket-1' }
let registered: { handler: (req: unknown, res: unknown) => Promise<void> }[]
let engine: { acceptSourceTrigger: ReturnType<typeof vi.fn>; receive: ReturnType<typeof vi.fn>; stopTicket: ReturnType<typeof vi.fn> }
const calls: { requestId?: string; text?: string }[] = []
function register() {
  const ctx = { webServer: { host: '127.0.0.1', port: 3080,
    register: (route: { handler: (req: unknown, res: unknown) => Promise<void> }) => { registered.push(route); return () => {} } } } as unknown as Context
  const host: BqaHttpHost = { store, sources: { instance: <C>() => instance as unknown as { enabled: boolean; config: C; id: string; kind: string } },
    engine: engine as unknown as BqaHttpHost['engine'], ready: Promise.resolve(), requestPass: () => {} }
  return registerBqaHttp(ctx, host)
}
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status?: number; body?: Record<string, unknown> }> {
  const response: { status?: number; body?: string } = {}
  const req = { url: path, method, headers, socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) } }
  const res = { writeHead: (status: number) => { response.status = status }, end: (text: string) => { response.body = text } }
  await registered[0]!.handler(req, res)
  return { status: response.status, body: response.body ? JSON.parse(response.body) as Record<string, unknown> : undefined }
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'bqa-'))
  store = new StoreClass(join(directory, 'db.sqlite'))
  instance = { enabled: true, config: BqaConfigSchema.parse({}) }
  registered = []
  engine = { acceptSourceTrigger: vi.fn(() => ({ result: 'stored', decision: accepted })), receive: vi.fn(), stopTicket: vi.fn() }
  process.env.BQA_SHARED_SECRET = SECRET
  register()
})
afterEach(() => {
  delete process.env.BQA_SHARED_SECRET
  store.close()
  rmSync(directory, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

describe('inbound routes', () => {
  it('refuses a request without the shared secret or from a non-loopback address', async () => {
    expect((await call('POST', '/bqa/api/questions', question)).status).toBe(403)
    expect((await call('POST', '/bqa/api/questions', question, { 'x-bqa-secret': 'wrong' })).status).toBe(403)
  })
  it('accepts a question once and answers a repeat as duplicate without a second Decision', async () => {
    const first = await call('POST', '/bqa/api/questions', question, { 'x-bqa-secret': SECRET })
    expect(first).toMatchObject({ status: 200, body: { triggerId: expect.any(String), ticketId: 'ticket-1', duplicate: false } })
    expect(engine.acceptSourceTrigger).toHaveBeenCalledTimes(1)
    // The worker needs the requestId unchanged to call the retrieval gateway; it rides in the ticket scope.
    expect(engine.acceptSourceTrigger.mock.calls[0]![1]).toMatchObject({ scope: expect.stringContaining('requestId=req-1') })
    expect(store.get(KV.bqa.request('req-1'))).toMatchObject({ triggerId: expect.any(String), ticketId: 'ticket-1' })
    const again = await call('POST', '/bqa/api/questions', question, { 'x-bqa-secret': SECRET })
    expect(again.body).toMatchObject({ ticketId: 'ticket-1', duplicate: true })
    expect(engine.acceptSourceTrigger).toHaveBeenCalledTimes(1)
  })
  it('refuses an invalid body and a requestId reused for another question', async () => {
    expect((await call('POST', '/bqa/api/questions', { ...question, releaseId: undefined }, { 'x-bqa-secret': SECRET })).status).toBe(400)
    await call('POST', '/bqa/api/questions', question, { 'x-bqa-secret': SECRET })
    expect((await call('POST', '/bqa/api/questions', { ...question, question: 'Different?' }, { 'x-bqa-secret': SECRET })).status).toBe(409)
  })
  it('falls back to the candidate path when autoAccept is off, and reports health without the secret', async () => {
    instance = { enabled: true, config: BqaConfigSchema.parse({ autoAccept: 'off' }) }
    const answer = await call('POST', '/bqa/api/questions', question, { 'x-bqa-secret': SECRET })
    expect(answer.body).toMatchObject({ ticketId: null })
    expect(engine.receive).toHaveBeenCalledTimes(1)
    expect((await call('GET', '/bqa/api/health')).body).toMatchObject({ state: 'ready' })
  })
  it('stops a ticket and refuses an unknown one', async () => {
    const ticket: Ticket = { id: 'ticket-1' } as Ticket
    store.tickets.save(ticket)
    expect((await call('POST', '/bqa/api/tickets/ticket-1/stop', {}, { 'x-bqa-secret': SECRET })).body).toEqual({ stopped: true })
    expect(engine.stopTicket).toHaveBeenCalledWith('ticket-1')
    expect((await call('POST', '/bqa/api/tickets/missing/stop', {}, { 'x-bqa-secret': SECRET })).status).toBe(404)
  })
})

describe('answers', () => {
  const USAGE: TokenUsage = { uncachedInputTokens: 120, outputTokens: 80, cacheReadTokens: 5, cacheWriteTokens: 7 }
  const CALLS: RetrievalCall[] = [
    { callId: 'call-1', toolName: 'mcp__bqa__search_knowledge', result: { retrieval_id: 'retrieval-1', corpus_release_id: 'release-1', sources: [] } },
    { callId: 'call-2', toolName: 'mcp__bqa__read_excerpt', result: { retrieval_id: 'retrieval-2', corpus_release_id: 'release-1' } },
    { callId: 'call-3', toolName: 'orchestrator_read', result: { ticket_id: 'ticket-1' } },
    { callId: 'call-4', toolName: 'mcp__bqa__search_code', result: { sources: [] } },
  ]
  const message = (id: string) => ({ id, kind: 'reply' as const, ticketId: 'ticket-1',
    channel: { source: 'bqa', thread: 'bqa:conv-1', address: { conversationId: 'conv-1', requestId: 'req-1', userId: 'user-1', status: 'ready' } },
    text: 'The answer' })
  it('relays only the three BQA read-only retrieval tools whose result carries the evidence identity BQA validates', () => {
    expect(bqaToolCalls(CALLS)).toEqual([CALLS[0], CALLS[1]])
  })
  it('maps the worker Session token counts to the flat fields BQA validates, billed total included', () => {
    expect(bqaUsage(USAGE)).toEqual({ input_tokens: 120, output_tokens: 80, total_tokens: 212,
      cache_read_input_tokens: 5, cache_creation_input_tokens: 7 })
  })
  it('posts the worker Session token counts and retrieval evidence with the answer', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await sendBqa({ commands: {} as never }, { ...message('m-usage'), usage: USAGE, retrievalCalls: CALLS }, BqaConfigSchema.parse({}))).toBe('sent')
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toMatchObject({ messageId: 'm-usage', usage: { input_tokens: 120, output_tokens: 80,
      total_tokens: 212, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 }, toolCalls: [CALLS[0], CALLS[1]] })
  })
  it('posts the answer to the BQA callback with the shared secret, and treats 4xx as gone', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await sendBqa({ commands: {} as never }, message('m1'), BqaConfigSchema.parse({}))).toBe('sent')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:8765/api/internal/superagent/answers')
    expect((init.headers as Record<string, string>)['x-bqa-secret']).toBe(SECRET)
    expect(JSON.parse(String(init.body))).toMatchObject({ messageId: 'm1', ticketId: 'ticket-1', status: 'ready', text: 'The answer' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 400 })))
    expect(await sendBqa({ commands: {} as never }, message('m2'), BqaConfigSchema.parse({}))).toBe('gone')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    await expect(sendBqa({ commands: {} as never }, message('m3'), BqaConfigSchema.parse({}))).rejects.toThrow('HTTP 500')
  })
  it('sends a ready report as the answer and any other result state as its status only', () => {
    const ticket = { id: 'ticket-1', channels: [{ source: 'bqa', thread: 'bqa:conv-1', address: { conversationId: 'conv-1', requestId: 'req-1', userId: 'user-1' } }] } as unknown as Ticket
    const outbox = { send: vi.fn() }
    const host = { outbox, sources: { instance: <C>() => instance as unknown as { enabled: boolean; config: C; id: string; kind: string } } }
    const report = (state: WorkerReport['state'], summary: string) => ({ state, summary, at: '2026-11-05T00:00:00.000Z' })
    bqaDirectReply(host, ticket, report('ready', 'The answer'))
    expect(outbox.send).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'bqa-reply:ticket-1:2026-11-05T00:00:00.000Z', text: 'The answer',
      kind: 'reply', channel: expect.objectContaining({ address: expect.objectContaining({ status: 'ready' }) }) }))
    bqaDirectReply(host, ticket, report('blocked', 'Need a person'))
    expect(outbox.send).toHaveBeenLastCalledWith(expect.objectContaining({ text: '', channel: expect.objectContaining({ address: expect.objectContaining({ status: 'blocked' }) }) }))
    bqaDirectReply(host, ticket, report('progress', 'Working'))
    expect(outbox.send).toHaveBeenCalledTimes(2)
    instance = { enabled: true, config: BqaConfigSchema.parse({ directReply: false }) }
    bqaDirectReply(host, ticket, report('ready', 'The answer'))
    expect(outbox.send).toHaveBeenCalledTimes(2)
  })
  it('forwards the report\'s token counts to the answer reply, for statuses too', () => {
    const ticket = { id: 'ticket-1', channels: [{ source: 'bqa', thread: 'bqa:conv-1', address: { conversationId: 'conv-1', requestId: 'req-1', userId: 'user-1' } }] } as unknown as Ticket
    const outbox = { send: vi.fn() }
    const host = { outbox, sources: { instance: <C>() => instance as unknown as { enabled: boolean; config: C; id: string; kind: string } } }
    const at = '2026-11-05T00:00:00.000Z'
    bqaDirectReply(host, ticket, { state: 'ready', summary: 'The answer', at, usage: USAGE })
    expect(outbox.send).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'The answer', usage: USAGE,
      channel: expect.objectContaining({ address: expect.objectContaining({ status: 'ready' }) }) }))
    bqaDirectReply(host, ticket, { state: 'blocked', summary: 'Need a person', at: '2026-11-05T00:00:01.000Z', usage: USAGE })
    expect(outbox.send).toHaveBeenLastCalledWith(expect.objectContaining({ text: '', usage: USAGE,
      channel: expect.objectContaining({ address: expect.objectContaining({ status: 'blocked' }) }) }))
    bqaDirectReply(host, ticket, { state: 'ready', summary: 'No meter', at: '2026-11-05T00:00:02.000Z' })
    expect(outbox.send).toHaveBeenLastCalledWith(expect.not.objectContaining({ usage: expect.anything() }))
    // The retrieval evidence travels with the report, for the channel to filter and validate.
    bqaDirectReply(host, ticket, { state: 'ready', summary: 'With evidence', at: '2026-11-05T00:00:03.000Z', usage: USAGE, retrievalCalls: CALLS })
    expect(outbox.send).toHaveBeenLastCalledWith(expect.objectContaining({ usage: USAGE, retrievalCalls: CALLS }))
  })
})

describe('question trigger', () => {
  it('carries the conversation thread, the question channel and the request metadata', () => {
    const input = BqaQuestionSchema.parse(question)
    const trigger = bqaTrigger(input)
    expect(trigger).toMatchObject({ source: 'bqa', human: true, addressed: 'direct', text: question.question,
      threads: [{ source: 'bqa', id: 'conv-1' }], actor: { source: 'bqa', id: 'user-1' },
      channel: { source: 'bqa', thread: 'bqa:conv-1', address: { conversationId: 'conv-1', requestId: 'req-1', userId: 'user-1' } } })
    expect(trigger.id).toBe(bqaTrigger(input).id)
    expect(trigger.meta).toMatchObject({ requestId: 'req-1', releaseId: 'release-1', mode: 'qa', userName: 'Ann' })
    expect(() => BqaQuestionSchema.parse({ ...question, mode: 'other' })).toThrow()
  })
})
