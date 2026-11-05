/** BQA source kind: authenticated questions from the BQA service, answered by tickets whose ready report is sent back. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key, type OutboundMessage, type Trigger } from '../core/index.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks, SourceChannel, SourceKind } from './kind.ts'
import { pause } from './poll.ts'

export const SOURCE = 'bqa'
const Label = { zh: 'BQA 业务问答', en: 'BQA questions' } as const
/** Configuration of the BQA Source; the shared secret comes only from `process.env.BQA_SHARED_SECRET`. */
export const BqaConfigSchema = z.object({
  taskType: z.string().trim().regex(/^[a-z][a-z0-9-]{0,63}$/, 'Use lowercase letters, digits and dashes, starting with a letter').default('consult'),
  autoAccept: z.enum(['explicit', 'off']).default('explicit'),
  directReply: z.boolean().default(true),
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
export function bqaTrigger(input: BqaQuestion): Trigger {
  const thread = `bqa:${input.conversationId}`
  return { id: key('bqa', input.requestId), source: SOURCE, threads: [{ source: SOURCE, id: input.conversationId }],
    actor: { source: SOURCE, id: input.userId }, human: true, addressed: 'direct', at: new Date().toISOString(), text: input.question,
    channel: { source: SOURCE, thread, address: { conversationId: input.conversationId, requestId: input.requestId, userId: input.userId } },
    meta: { requestId: input.requestId, conversationId: input.conversationId, releaseId: input.releaseId, mode: input.mode,
      ...input.userName ? { userName: input.userName } : {}, ...input.deadlineAt ? { deadlineAt: input.deadlineAt } : {},
      ...input.answerCheck === undefined ? {} : { answerCheck: input.answerCheck } } }
}

/**
 * Sends one answer (or status) to the BQA service's internal callback, authenticated by `x-bqa-secret`. A 4xx is permanent and
 * settles as a gone conversation; a 5xx or a network failure throws so the reply effect retries with backoff.
 */
export async function sendBqa(_host: Pick<SourceContext, 'commands'>, message: OutboundMessage, config: BqaConfig): Promise<'sent' | 'gone'> {
  const secret = process.env.BQA_SHARED_SECRET
  if (!secret) throw new Error('BQA_SHARED_SECRET is not set, so BQA answers cannot be delivered')
  const address = message.channel.address
  const body = { messageId: message.id, requestId: address.requestId ?? '', ticketId: message.ticketId ?? '',
    conversationId: address.conversationId ?? '', userId: address.userId ?? '', status: address.status ?? 'ready', text: message.text,
    at: new Date().toISOString() }
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
    { key: 'bqaBaseUrl', type: 'text', advanced: true, label: { zh: 'BQA 地址', en: 'BQA base URL' },
      hint: { zh: '答案回传与健康检查使用的 BQA 服务根地址。', en: 'The BQA service root used for answer callbacks and health checks.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 5, max: 300, label: { zh: '健康检查间隔 / 秒', en: 'Health check interval / seconds' } },
  ],
  health: ['bqa'],
  // Every BQA question is a direct message from an authenticated person, so the scope listens to it in full.
  scope: () => ({ listened: true, observed: false, row: 'questions' }),
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
