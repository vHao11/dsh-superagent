/** BQA source kind: authenticated questions from the BQA service, answered by tickets whose ready report is sent back. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key, type OutboundMessage, type RetrievalCall, type TokenUsage, type Trigger } from '../core/index.ts'
import { ConversationModeSchema, continuityOf, conversationField } from './conversation.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks, SourceChannel, SourceKind } from './kind.ts'
import { pause } from './poll.ts'

export const SOURCE = 'bqa'
const Label = { zh: 'BQA 业务问答', en: 'BQA questions' } as const
/** The server name the BQA MCP client mounts under; its tools are named `mcp__bqa__<rawName>`. */
export const BQA_MCP_SERVER = 'bqa'
/** The raw names of the three read-only retrieval tools the BQA MCP server exposes. */
export const BQA_MCP_TOOL_NAMES = ['search_knowledge', 'search_code', 'read_excerpt'] as const
/** One retrieval tool call relayed to BQA as evidence, with the MCP tool's result object. */
export interface BqaToolCall { callId: string; toolName: string; result: Record<string, unknown> }
/** The answer callback's bounds, mirroring BQA's own validation so a malformed evidence list never rejects the whole answer. */
const BQA_MAX_TOOL_CALLS = 40, BQA_MAX_TOOL_CALL_BYTES = 512 * 1024
/** Configuration of the BQA Source; the shared secret comes only from `process.env.BQA_SHARED_SECRET`. */
export const BqaConfigSchema = z.object({
  taskType: z.string().trim().regex(/^[a-z][a-z0-9-]{0,63}$/, 'Use lowercase letters, digits and dashes, starting with a letter').default('consult'),
  autoAccept: z.enum(['explicit', 'off']).default('explicit'),
  directReply: z.boolean().default(true),
  /** Whether each question is its own conversation, its own Ticket and Session, or the window's questions share one. */
  conversation: ConversationModeSchema.default('off'),
  bqaBaseUrl: z.string().trim().url().default('http://127.0.0.1:8765'),
  pollSeconds: z.number().int().min(5).max(300).default(30),
}).strict()
export type BqaConfig = z.infer<typeof BqaConfigSchema>
/** One question the BQA service pushes; its `requestId` makes the delivery idempotent. */
export const BqaQuestionSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  conversationId: z.string().trim().min(1).max(200),
  userId: z.string().trim().min(1).max(200),
  userName: z.string().trim().max(200).optional(),
  question: z.string().trim().min(1).max(200_000),
  releaseId: z.string().trim().min(1).max(200),
  mode: z.enum(['qa', 'troubleshooting']),
  answerCheck: z.unknown().optional(),
  deadlineAt: z.string().trim().max(100).optional(),
}).strict()
export type BqaQuestion = z.infer<typeof BqaQuestionSchema>
/** The title a BQA question's ticket takes: the question's first line, shortened to a ticket-sized title. */
export const bqaTitle = (question: string): string => question.replace(/\s+/g, ' ').trim().slice(0, 160) || 'BQA question'
/**
 * Builds the Trigger of one BQA question: its conversation is the Thread, the authenticated user is the actor, and its
 * Channel carries what the answer callback needs. The id is stable per `requestId`, so a retried delivery is no duplicate.
 */
export function bqaTrigger(input: BqaQuestion, config: Pick<BqaConfig, 'conversation'> = { conversation: 'off' }): Trigger {
  const thread = `bqa:${input.conversationId}`
  return { id: key('bqa', input.requestId), source: SOURCE, threads: [{ source: SOURCE, id: input.conversationId }],
    actor: { source: SOURCE, id: input.userId }, human: true, addressed: 'direct', at: new Date().toISOString(), text: input.question,
    continuity: continuityOf(config.conversation),
    channel: { source: SOURCE, thread, address: { conversationId: input.conversationId, requestId: input.requestId, userId: input.userId } },
    meta: { requestId: input.requestId, conversationId: input.conversationId, releaseId: input.releaseId, mode: input.mode,
      ...input.userName ? { userName: input.userName } : {}, ...input.deadlineAt ? { deadlineAt: input.deadlineAt } : {},
      ...input.answerCheck === undefined ? {} : { answerCheck: input.answerCheck } } }
}

/**
 * The token counts BQA records for one delegated run, in the flat snake_case shape its answer callback validates: uncached
 * input and output, cache reads and writes, and the billed total (both cache kinds included in the prompt side). BQA's own
 * maintenance summary adds the cache counts to `input_tokens` and keeps `total_tokens`, so both forms agree.
 */
export function bqaUsage(usage: TokenUsage): { input_tokens: number; output_tokens: number; total_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } {
  return { input_tokens: usage.uncachedInputTokens, output_tokens: usage.outputTokens,
    total_tokens: usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
    cache_read_input_tokens: usage.cacheReadTokens, cache_creation_input_tokens: usage.cacheWriteTokens }
}

/**
 * Select the retrieval calls BQA records as evidence of one answer: only its three read-only retrieval tools, only when the
 * result object carries the identity BQA validates (`retrieval_id` and `corpus_release_id`), capped at 40 calls and 512 KiB
 * of JSON so BQA accepts the whole answer callback. Anything else is dropped instead of failing the answer.
 */
export function bqaToolCalls(calls: readonly RetrievalCall[]): BqaToolCall[] {
  const prefix = `mcp__${BQA_MCP_SERVER}__`
  const selected: BqaToolCall[] = []
  for (const call of calls) {
    if (selected.length >= BQA_MAX_TOOL_CALLS) break
    if (!call.toolName.startsWith(prefix) || !(BQA_MCP_TOOL_NAMES as readonly string[]).includes(call.toolName.slice(prefix.length))) continue
    if (typeof call.result.retrieval_id !== 'string' || typeof call.result.corpus_release_id !== 'string') continue
    selected.push({ callId: call.callId, toolName: call.toolName, result: call.result })
  }
  while (selected.length && JSON.stringify(selected).length > BQA_MAX_TOOL_CALL_BYTES) selected.pop()
  return selected
}

/**
 * Sends one answer (or status) to the BQA service's internal callback, authenticated by `x-bqa-secret`, with the worker's token
 * usage and its read-only retrieval evidence when the report carries them. A 4xx is permanent and settles as a gone
 * conversation; a 5xx or a network failure throws so the reply effect retries with backoff.
 */
export async function sendBqa(_host: Pick<SourceContext, 'commands'>, message: OutboundMessage, config: BqaConfig): Promise<'sent' | 'gone'> {
  const secret = process.env.BQA_SHARED_SECRET
  if (!secret) throw new Error('BQA_SHARED_SECRET is not set, so BQA answers cannot be delivered')
  const address = message.channel.address
  const toolCalls = message.retrievalCalls ? bqaToolCalls(message.retrievalCalls) : []
  const body = { messageId: message.id, requestId: address.requestId ?? '', ticketId: message.ticketId ?? '',
    conversationId: address.conversationId ?? '', userId: address.userId ?? '', status: address.status ?? 'ready', text: message.text,
    at: new Date().toISOString(), ...(message.usage ? { usage: bqaUsage(message.usage) } : {}), ...(toolCalls.length ? { toolCalls } : {}) }
  let response: Response
  try {
    response = await fetch(`${config.bqaBaseUrl.replace(/\/+$/, '')}/api/internal/superagent/answers`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bqa-secret': secret }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) })
  } catch (error) {
    throw new Error(`The BQA answer callback failed: ${String(error)}`)
  }
  if (response.status >= 400 && response.status < 500) return 'gone'
  if (!response.ok) throw new Error(`The BQA answer callback failed: HTTP ${response.status}`)
  const result = await response.json().catch(() => ({})) as { accepted?: boolean }
  return result.accepted === false ? 'gone' : 'sent'
}

const bqaChannel: SourceChannel<BqaConfig> = {
  send: (host, message, config) => sendBqa(host, message, config),
  allowed: () => true,
  link: (_address, _links: ChannelLinks): ChannelLink => ({ url: '', label: { zh: 'BQA 问答', en: 'BQA question' } }),
}

export const bqaKind: SourceKind<BqaConfig> = {
  kind: SOURCE,
  title: Label,
  description: { zh: 'BQA 服务推送提问后自动建单，worker 的完成报告正文直接回传 BQA；共享密钥只从环境变量 BQA_SHARED_SECRET 读取。',
    en: 'Accept questions pushed by the BQA service, create their tickets automatically, and send each ready report\'s full text back; the shared secret comes only from BQA_SHARED_SECRET.' },
  schema: BqaConfigSchema,
  fields: [
    { key: 'autoAccept', type: 'select', label: { zh: '接单方式', en: 'Acceptance' },
      options: [{ value: 'explicit', label: { zh: '直接接单', en: 'Accept directly' } }, { value: 'off', label: { zh: '走候选评估', en: 'Assess as a candidate' } }],
      hint: { zh: 'BQA 已完成登录鉴权，直接接单不经过主 Session；关闭后 BQA 提问按普通候选处理。',
        en: 'BQA authenticates its users, so direct acceptance skips the main Session; when off, its questions are ordinary candidates.' } },
    { key: 'taskType', type: 'text', label: { zh: '任务类型 id', en: 'Task type id' },
      hint: { zh: 'BQA 工单使用的任务类型（需要先在执行器设置里配置），默认 consult。', en: 'The task type of BQA tickets, configured in the executor settings first; consult by default.' } },
    { key: 'directReply', type: 'switch', label: { zh: '答案直回', en: 'Send answers back directly' },
      hint: { zh: 'worker 报告完成时把报告正文回传 BQA；blocked/failed/dropped 只回传状态。', en: 'Send a ready report\'s full text back to BQA; blocked, failed and dropped send their status only.' } },
    conversationField('off'),
    { key: 'bqaBaseUrl', type: 'text', advanced: true, label: { zh: 'BQA 地址', en: 'BQA base URL' },
      hint: { zh: '答案回传与健康检查使用的 BQA 服务根地址。', en: 'The BQA service root used for answer callbacks and health checks.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 5, max: 300, label: { zh: '健康检查间隔 / 秒', en: 'Health check interval / seconds' } },
  ],
  health: ['bqa'],
  // Every BQA question is a direct message from an authenticated person, so the scope listens to it in full.
  scope: () => ({ listened: true, observed: false, row: 'questions' }),
  // Its shared secret authenticates each question, so an explicit BQA Mandate revalidates without the (unused) allow-list.
  authenticates: true,
  taskType: (_trigger, config) => config.taskType,
  channel: bqaChannel,
  threadContext: {
    messageId: trigger => trigger.id,
    read: async (_commands, trigger, part) => part === 'thread' || part === 'root' || part === 'parent'
      ? { messages: [{ id: trigger.id, from: trigger.actor.id, at: trigger.at, text: trigger.text }], body: {} }
      : { messages: [], body: {} },
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().trim().min(1), name: z.string().trim().max(100).optional() }).strict()).default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '不使用的白名单', en: 'Unused allow-list' },
      hint: { zh: 'BQA 的入站鉴权由共享密钥完成；直接接单不需要名单，这里的条目只用于把接单方式切回候选评估时。',
        en: 'BQA authenticates inbound questions with the shared secret; direct acceptance needs no list, and these entries only matter when questions fall back to candidate assessment.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '.+' },
        { key: 'name', type: 'text', label: { zh: '名称', en: 'Name' }, optional: true }] }],
    explicit: { zh: 'BQA 提问是已登录用户直接对 agent 发起的请求，来源自证鉴权；直接接单不经过准入表。',
      en: 'A BQA question is a signed-in user\'s direct request, authenticated by the Source; direct acceptance bypasses the admission table.' },
    rows: () => [{ id: 'questions', label: Label, note: { zh: '按提问产生', en: 'Produced per question' },
      cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } }],
  },
}

export const name = 'dsh-superagent-bqa'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(bqaKind), 'bqa: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, bqaKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal).catch((error: unknown) => { source.report('bqa', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report('bqa', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<BqaConfig>(SOURCE)
    if (!config) ctx.report('bqa', health('paused', 'sourceOff'))
    else if (!process.env.BQA_SHARED_SECRET) ctx.report('bqa', { state: 'error', detail: 'BQA_SHARED_SECRET is not set, so inbound questions and answer callbacks are refused' })
    else {
      try {
        const response = await fetch(`${config.bqaBaseUrl.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(5_000) })
        ctx.report('bqa', response.ok ? { state: 'ready', detail: `${config.bqaBaseUrl} is reachable`, at: new Date().toISOString() }
          : { state: 'error', detail: `${config.bqaBaseUrl}/health returned HTTP ${response.status}` })
      } catch (error) {
        if (signal.aborted) return
        ctx.report('bqa', { state: 'error', detail: String(error) })
      }
    }
    await pause((ctx.config<BqaConfig>(SOURCE)?.pollSeconds ?? 30) * 1000, signal)
  }
}
