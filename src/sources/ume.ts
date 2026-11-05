/** UME source kind: reads the UME message-capture triage export and turns changed conversations into Triggers. */
import type { Context } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import { isAbsolute, win32 } from 'node:path'
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { pause } from './poll.ts'

export const SOURCE = 'ume'
const Label = { zh: 'UME 会话', en: 'UME conversations' } as const
/** The triage file `ume-message-capture` writes; only its documented fields are read. */
export const UmeConfigSchema = z.object({
  file: z.string().trim().min(1).refine(path => isAbsolute(path) || win32.isAbsolute(path), 'An absolute path')
    .default('D:/aiworkspace/ai-tools/ume-message-capture/data/tasks.json'),
  pollSeconds: z.number().int().min(5).max(300).default(60),
}).strict()
export type UmeConfig = z.infer<typeof UmeConfigSchema>
/** One triage row: the capture tool's own fields, kept loosely typed because the export is external. */
type Task = Record<string, unknown>
const asText = (value: unknown): string | undefined => typeof value === 'string' && value ? value : typeof value === 'number' ? String(value) : undefined
const asNumber = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const asList = (value: unknown): string[] => Array.isArray(value) ? value.flatMap(item => asText(item) ?? []) : asText(value) ? [asText(value)!] : []
const iso = (value: string): string => { const at = Date.parse(value); return Number.isFinite(at) ? new Date(at).toISOString() : value }

/**
 * Builds the Trigger of one triage row: its conversation is the Thread, so updates of one conversation share an Eval, and
 * its `last_time` keeps the id stable, so re-reading the same export produces no duplicate.
 */
export function umeTrigger(task: Task, file: string): Trigger | undefined {
  const sid = asText(task.sid)
  const last = asText(task.last_time)
  if (!sid || !last) return undefined
  const name = asText(task.name)
  const context = asText(task.context) ?? name ?? sid
  const reasons = asList(task.reasons)
  return { id: key('ume', sid, last), source: SOURCE, threads: [{ source: SOURCE, id: sid }],
    actor: { source: SOURCE, id: asText(task.chatter_id) ?? '' }, human: true, at: iso(last), text: context,
    meta: { file, sid, lastTime: last, ...name ? { name } : {}, ...asText(task.priority) ? { priority: asText(task.priority) } : {},
      ...asText(task.type) ? { type: asText(task.type) } : {}, ...asNumber(task.unread) !== undefined ? { unread: asNumber(task.unread) } : {},
      ...reasons.length ? { reasons } : {} } }
}

/** Reads and validates one exported tasks file; a missing or malformed file throws, which the loop reports as Source health. */
export async function readUmeTasks(file: string): Promise<Task[]> {
  const text = await readFile(file, 'utf8')
  const parsed: unknown = JSON.parse(text)
  if (!Array.isArray(parsed)) throw new Error('The UME export is not a JSON array')
  return parsed.filter((item): item is Task => !!item && typeof item === 'object' && !Array.isArray(item))
}

/** Reads one rows per conversation export and queues a Trigger for every conversation whose latest message is new; returns how many. */
export async function pollUme(ctx: SourceContext, config: UmeConfig): Promise<number> {
  const tasks = await readUmeTasks(config.file)
  let fresh = 0
  for (const task of tasks) {
    // `last_mine` means the conversation's latest message is ours: it asks for nothing from a colleague.
    if (task.last_mine === true) continue
    const trigger = umeTrigger(task, config.file)
    if (!trigger) continue
    const sid = String(trigger.meta.sid)
    if (ctx.state.get(KV.ume.last(config.file, sid)) === trigger.meta.lastTime) continue
    await ctx.receive(trigger)
    ctx.state.set(KV.ume.last(config.file, sid), String(trigger.meta.lastTime))
    const name = asText(task.name)
    if (name) ctx.threads.describe(trigger.threads[0]!.source + ':' + sid, { label: name, facts: { ume: { label: Label, value: name } } })
    fresh += 1
  }
  return fresh
}

export const umeKind: SourceKind<UmeConfig> = {
  kind: SOURCE,
  title: Label,
  description: { zh: '只读取 UME 采集工具导出的 data/tasks.json，不读客户端库、不发送消息；每个有更新的会话按线程产生一条候选。',
    en: 'Reads UME message-capture\'s exported data/tasks.json only, never its client store and never sends messages; each updated conversation becomes one Trigger on its own Thread.' },
  schema: UmeConfigSchema,
  fields: [
    { key: 'file', type: 'text', label: { zh: '导出文件', en: 'Export file' },
      hint: { zh: 'ume-message-capture 的 data/tasks.json 绝对路径；文件缺失或格式错误时来源报错，不影响其他来源。',
        en: 'Absolute path of UME message-capture\'s data/tasks.json; a missing or malformed file makes this Source report an error without affecting others.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 5, max: 300, label: { zh: '检查间隔 / 秒', en: 'Check interval / seconds' },
      hint: { zh: '多久读一次导出文件；导出本身由计划任务每 10 分钟刷新。', en: 'How often to read the export; a scheduled task refreshes the export itself every ten minutes.' } },
  ],
  health: ['ume'],
  // UME exports every triaged conversation, so the scope observes all of them and the admission table judges each one.
  scope: () => ({ listened: true, observed: true, row: 'chats' }),
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().trim().min(1), name: z.string().trim().max(100).optional() }).strict()).default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '可授权建单的同事', en: 'Colleagues who may authorize work' },
      hint: { zh: 'UME 消息没有 @ 机器人；只有这里的同事在白名单单元格被设为“明确请求”时，主 Session 才能直接接单。',
        en: 'UME messages never address the agent; only a colleague listed here, in a row whose admission cell grants Explicit, lets the main Session accept directly.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '.+' },
        { key: 'name', type: 'text', label: { zh: '名称', en: 'Name' }, optional: true }] }],
    explicit: { zh: 'UME 消息不是对 agent 说的；只有准入表对白名单同事放行“明确请求”时才算明确请求。',
      en: 'A UME message does not address the agent; it is explicit only when the admission table grants Explicit to a listed colleague.' },
    rows: () => [{ id: 'chats', label: Label, note: { zh: '按会话产生', en: 'Produced per conversation' },
      cells: { listedUnaddressed: true, unlistedAddressed: false, unlistedUnaddressed: true } }],
  },
}

export const name = 'dsh-superagent-ume'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(umeKind), 'ume: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, umeKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the loop is reported as Source health instead.
    const running = watch(source, controller.signal).catch((error: unknown) => { source.report('ume', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report('ume', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<UmeConfig>(SOURCE)
    if (!config) ctx.report('ume', health('paused', 'sourceOff'))
    else {
      try {
        const fresh = await pollUme(ctx, config)
        ctx.report('ume', { state: 'ready', detail: `${fresh} updated conversations; ${config.file}`, at: new Date().toISOString() })
      } catch (error) {
        if (signal.aborted) return
        ctx.report('ume', { state: 'error', detail: String(error) })
      }
    }
    await pause((ctx.config<UmeConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}
