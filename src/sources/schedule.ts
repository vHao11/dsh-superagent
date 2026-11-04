/** Schedule source kind: interval tasks declared in settings, each optionally feeding superagent. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'
import { family } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import { pause } from './poll.ts'

export const SOURCE = 'schedule'
/** Last due time (epoch ms) per scheduled task; kept so a restart does not replay a task before its interval passes. */
const lastDue = family<number, [id: string]>('schedule-last:')
const Env = { zh: '定时任务', en: 'Scheduled tasks' } as const
const ScheduleEntry = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'Lowercase letters, digits and dashes; at most 32 characters'),
  // Kept as a string: the settings store re-reads every saved config through this schema, so parsing must be idempotent.
  every: z.string().trim().regex(/^\d+$/, 'Whole seconds').refine(value => Number(value) >= 60 && Number(value) <= 86400, '60 to 86400 seconds'),
  text: z.string().trim().min(1).max(2000),
  on: z.enum(['on', 'off']).default('on'),
}).strict()
export const ScheduleConfigSchema = z.object({
  pollSeconds: z.number().int().min(5).max(300).default(10),
  schedules: z.array(ScheduleEntry)
    .refine(items => new Set(items.map(item => item.id)).size === items.length, 'Duplicate schedule IDs')
    .default([]),
}).strict()
export type ScheduleConfig = z.infer<typeof ScheduleConfigSchema>

/** Builds one Trigger for a due task; the ID is stable within an interval bucket so overlapping checks deduplicate. */
export function scheduleTrigger(entry: { id: string; every: string; text: string }, at: string): Trigger {
  const seconds = Number(entry.every)
  const bucket = Math.floor(Date.parse(at) / (seconds * 1000))
  return {
    id: key('schedule', entry.id, String(bucket)),
    source: SOURCE,
    threads: [{ source: SOURCE, id: entry.id }],
    actor: { source: SOURCE, id: '' },
    human: false,
    at,
    text: entry.text,
    meta: { scheduleId: entry.id, everySeconds: seconds },
  }
}

export const scheduleKind: SourceKind<ScheduleConfig> = {
  kind: SOURCE,
  title: Env,
  description: { zh: '按设置里的间隔产生事件；每条任务可单独选择是否接入 superagent 来源。',
    en: 'Produces events on the intervals configured here; each task can be set to feed superagent or not.' },
  schema: ScheduleConfigSchema,
  fields: [
    { key: 'schedules', type: 'rows', label: Env,
      hint: { zh: '每行一个定时任务；“接入”为开时才把到点的事件送进 superagent，关闭的行仍然保留但不产生事件。间隔最短 60 秒。',
        en: 'One task per row; only a row set to On feeds superagent when due, while an Off row is kept without producing events. The shortest interval is 60 seconds.' },
      columns: [
        { key: 'id', type: 'text', label: { zh: 'ID', en: 'ID' }, pattern: '[a-z0-9][a-z0-9\\-]{0,31}' },
        { key: 'every', type: 'text', label: { zh: '间隔 / 秒', en: 'Interval / seconds' }, pattern: '[0-9]+' },
        { key: 'text', type: 'text', label: { zh: '内容', en: 'Text' } },
        { key: 'on', type: 'select', label: { zh: '接入', en: 'Feed' },
          options: [{ value: 'on', label: { zh: '接入', en: 'On' } }, { value: 'off', label: { zh: '不接入', en: 'Off' } }] },
      ] },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 5, max: 300,
      label: { zh: '检查间隔 / 秒', en: 'Check interval / seconds' },
      hint: { zh: '多久检查一次有没有到点的任务；不改变任务自身的间隔。', en: 'How often to check for due tasks; does not change a task\'s own interval.' } },
  ],
  health: ['schedule'],
  // Scheduled events have no sender or conversation: each one is observed in full, and the admission table decides.
  scope: () => ({ listened: true, observed: true, row: 'schedules' }),
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().trim().min(1) }).strict()).default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的账号', en: 'Accounts that may originate work' },
      hint: { zh: '定时任务没有发送人；这里的名单只用于记录，是否成为候选由准入表决定。', en: 'Scheduled tasks have no sender; this list is only recorded, and the admission table decides whether one becomes a candidate.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '.+' }] }],
    explicit: { zh: '定时任务没有发送人，不存在“明确请求”；每一条都按准入表判定。', en: 'A scheduled task has no sender, so none is an explicit request; the admission table judges every one.' },
    rows: () => [{ id: 'schedules', label: Env, note: { zh: '按间隔产生', en: 'Produced on an interval' },
      cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: true } }],
  },
}

export const name = 'dsh-superagent-schedule'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(scheduleKind), 'schedule: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, scheduleKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the loop is reported as source health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('schedule', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report('schedule', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<ScheduleConfig>(SOURCE)
    if (!config) {
      ctx.report('schedule', health('paused', 'sourceOff'))
    } else {
      const now = Date.now()
      let due = 0
      try {
        for (const entry of config.schedules) {
          if (entry.on !== 'on') continue
          const previous = ctx.state.get(lastDue(entry.id)) ?? 0
          if (now - previous < Number(entry.every) * 1000) continue
          // Record the due time before receiving so a slow receive does not double-fire; a failed receive waits one interval.
          ctx.state.set(lastDue(entry.id), now)
          await ctx.receive(scheduleTrigger(entry, new Date(now).toISOString()))
          due += 1
        }
        ctx.report('schedule', { state: 'ready', detail: `${config.schedules.filter(entry => entry.on === 'on').length} tasks on; ${due} due`, at: new Date(now).toISOString() })
      } catch (error) {
        if (signal.aborted) return
        ctx.report('schedule', { state: 'error', detail: String(error) })
      }
    }
    await pause((ctx.config<ScheduleConfig>(SOURCE)?.pollSeconds ?? 10) * 1000, signal)
  }
}
