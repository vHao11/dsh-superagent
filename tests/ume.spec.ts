/** The UME Source: the exported conversations as Triggers, its watermark, and the explicit admission the operator may grant. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { UmeConfigSchema, pollUme, readUmeTasks, umeKind, umeTrigger } from '../src/sources/ume.ts'

let directory: string
let file: string
const row = (sid: string, last: string, extra: Record<string, unknown> = {}) => ({ sid, last_time: last, chatter_id: 'alice', name: `name ${sid}`,
  context: `context ${sid}`, priority: 'high', type: 'chat', unread: 2, reasons: ['mention'], last_mine: false, ...extra })
const tasks = (): unknown[] => [row('c1', '2026-11-05T01:00:00Z'), row('c2', '2026-11-05T02:00:00Z'), row('c3', '2026-11-05T03:00:00Z')]
function context(): { context: SourceContext; seen: Map<string, unknown>; received: string[]; described: string[] } {
  const seen = new Map<string, unknown>()
  const received: string[] = []
  const described: string[] = []
  const value = {
    ready: Promise.resolve(), configured: () => true, deployment: undefined,
    state: { get: (key: string) => seen.get(key), set: (key: string, item: unknown) => { seen.set(key, item) }, keys: () => [] },
    receive: async (trigger: { id: string }) => { received.push(trigger.id); return 'stored' as const },
    threads: { describe: (key: string) => { described.push(key) } },
  } as unknown as SourceContext
  return { context: value, seen, received, described }
}
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'ume-')); file = join(directory, 'tasks.json'); writeFileSync(file, JSON.stringify(tasks())) })
afterEach(() => rmSync(directory, { recursive: true, force: true }))

it('reads one Trigger per changed conversation and does not repeat it on the next poll', async () => {
  const { context: ctx, received, described } = context()
  const config = UmeConfigSchema.parse({ file })
  expect(await pollUme(ctx, config)).toBe(3)
  expect(await pollUme(ctx, config)).toBe(0)
  expect(received).toHaveLength(3)
  expect(described).toEqual(['ume:c1', 'ume:c2', 'ume:c3'])
  // A changed conversation (a new last_time) becomes one new Trigger.
  writeFileSync(file, JSON.stringify([row('c1', '2026-11-05T04:00:00Z')]))
  expect(await pollUme(ctx, config)).toBe(1)
})

it('builds a human Trigger on the conversation thread, with a stable id and the export facts', () => {
  const trigger = umeTrigger(row('c1', '2026-11-05T01:00:00Z'), file)!
  expect(trigger).toMatchObject({ source: 'ume', human: true, text: 'context c1', threads: [{ source: 'ume', id: 'c1' }],
    actor: { source: 'ume', id: 'alice' }, at: '2026-11-05T01:00:00.000Z' })
  expect(trigger.id).toBe(umeTrigger(row('c1', '2026-11-05T01:00:00Z'), file)!.id)
  expect(trigger.meta).toMatchObject({ sid: 'c1', priority: 'high', type: 'chat', unread: 2, reasons: ['mention'] })
})

it('joins the capture tool\'s context message list into the Trigger text', () => {
  // The real UME export stores `context` as message objects, not a string; the latest conversation text is what a candidate needs.
  const exportRow = { sid: 123, last_time: '2026-11-03T16:03:59.920000+08:00', chatter_id: 'alice', name: 'group A',
    context: [{ sender: 'alice', text: 'first line', at: '2026-11-03T15:00:00+08:00' },
      { sender: { id: 'u2', name: 'Bob' }, text: 'latest line', at: '2026-11-03T16:03:59+08:00' }], last_mine: false }
  const trigger = umeTrigger(exportRow, file)!
  expect(trigger.text).toBe('alice: first line\nBob: latest line')
  expect(trigger.threads).toEqual([{ source: 'ume', id: '123' }])
  expect(trigger.meta).toMatchObject({ sid: '123', name: 'group A' })
})

it('skips conversations whose latest message is ours and reports a missing or malformed export', async () => {
  const { context: ctx, received } = context()
  writeFileSync(file, JSON.stringify([row('c1', '2026-11-05T01:00:00Z', { last_mine: true })]))
  expect(await pollUme(ctx, UmeConfigSchema.parse({ file }))).toBe(0)
  expect(received).toEqual([])
  writeFileSync(file, 'not json')
  await expect(readUmeTasks(file)).rejects.toThrow()
  rmSync(file)
  await expect(readUmeTasks(file)).rejects.toThrow()
})

it('confines UME conversations to the chats scope, and only the admission table can make one explicit', () => {
  const config = UmeConfigSchema.parse({ file })
  expect(umeKind.scope!({ meta: {} }, config)).toEqual({ listened: true, observed: true, row: 'chats' })
  const settings = SettingsSchema.parse({ sources: { ume: { enabled: true, config: { file } } },
    policy: { sources: { ume: { allowed: [{ id: 'alice' }], admission: { chats: { listedUnaddressed: 'explicit' } } } } } })
  const policy = settingsPolicy(settings, { scope: input => umeKind.scope!(input, config) })
  const trigger = umeTrigger(row('c1', '2026-11-05T01:00:00Z'), file)!
  const thread = { key: 'ume:c1', ref: trigger.threads[0]!, createdAt: '', subscriptions: [], correlated: [], pending: [], meta: {} }
  expect(policy.gate(trigger, thread, [])).toMatchObject({ admissible: true, strength: 'explicit' })
  // Without the explicit cell, the configured default keeps it an inferred candidate.
  const inferred = settingsPolicy(SettingsSchema.parse({ sources: { ume: { enabled: true, config: { file } } },
    policy: { sources: { ume: { allowed: [{ id: 'alice' }] } } } }), { scope: input => umeKind.scope!(input, config) })
  expect(inferred.gate(trigger, thread, [])).toMatchObject({ admissible: true, strength: 'inferred' })
})
