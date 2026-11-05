/** Task types: work cannot proceed unclassified; the sorter or a Source names the type, and the host binds directory, model and instructions. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { Trigger } from '../src/core/index.ts'
import { TaskTypeSchema } from '../src/policy.ts'
import { workToolsFor } from '../src/app/sessions.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

const type = (overrides: Record<string, unknown> = {}) => ({
  id: 'docs', name: 'Docs', description: 'Documentation work.', examples: ['update the README'], not: ['change code'],
  directory: join(h.directory, 'docs'), model: null, directoryMode: 'fixed' as const, instructions: 'Follow the docs style.',
  readOnly: false,
  ...overrides,
})
function seedTypes(types: ReturnType<typeof type>[]): void {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, taskTypes: types } })
}
/** Stamps a Trigger the way a Source's context does for its configured default; source-level stamping has its own spec. */
const withSourceDefault = (trigger: Trigger, taskType: string): Trigger => ({ ...trigger, taskType })
async function accept(trigger: Trigger, taskType?: string) {
  h.runtime.receive(trigger)
  await h.runtime.idle()
  const result = await h.route({ kind: 'accept', trigger_id: trigger.id, title: 'Fix', worktree_name: 'fix-test',
    acknowledgement: '收到，处理中。', ...(taskType ? { taskType } : {}) })
  await h.runtime.idle()
  return h.runtime.store.tickets.get((result.ticket as { ticket_id: string }).ticket_id)!
}

describe('task types', () => {
  it('binds an explicitly chosen type to the ticket directory, mode, model and instructions', async () => {
    const code = type({ id: 'code', name: 'Code', description: 'Code work.', directory: join(h.directory, 'code'),
      directoryMode: 'per-ticket', model: { provider: 'provider-a', model: 'model-a' }, instructions: 'Change code only.' })
    seedTypes([code])

    const ticket = await accept(feishu('1', '@bot fix the login page'), 'code')

    expect(ticket.execution).toMatchObject({ taskType: 'code', taskTypeSource: 'explicit', directoryMode: 'per-ticket',
      model: { provider: 'provider-a', model: 'model-a' }, instructions: 'Change code only.' })
    expect(ticket.execution!.directory).toBe(join(join(h.directory, 'code'), `fix-test-${ticket.id.slice(0, 12)}`))
    const worker = h.agents.get(`worker-${ticket.id}`) as unknown as { session: { append: { mock: { calls: unknown[][] } } } }
    expect(worker.session.append.mock.calls).toContainEqual(['model/selection', { provider: 'provider-a', model: 'model-a' }])
  })

  it('refuses work that is neither explicitly typed nor covered by a Source default, and refuses unknown ids', async () => {
    seedTypes([type({ id: 'docs', name: 'Docs' })])

    await expect(accept(feishu('2', '@bot document the endpoint'))).rejects.toThrow(/Work cannot proceed unclassified/)
    await expect(accept(feishu('3', '@bot write the endpoint docs'), 'does-not-exist')).rejects.toThrow(/Unknown task type does-not-exist/)
    expect(h.runtime.store.tickets.open()).toHaveLength(0)
  })

  it('classifies by the Source default when the sorter omits a type', async () => {
    seedTypes([type({ id: 'docs', name: 'Docs' }), type({ id: 'code', name: 'Code', directory: join(h.directory, 'code') })])

    const ticket = await accept(withSourceDefault(feishu('4', '@bot improve the endpoint'), 'code'))

    expect(ticket.execution).toMatchObject({ taskType: 'code', taskTypeSource: 'source', directory: join(h.directory, 'code') })
  })

  it('refuses an unknown explicit id even when a Source default exists', async () => {
    seedTypes([type({ id: 'docs', name: 'Docs' })])

    await expect(accept(withSourceDefault(feishu('5', '@bot improve the endpoint'), 'docs'), 'nope')).rejects.toThrow(/Unknown task type nope/)
  })

  it('inherits the executor model when the type names none and keeps a type model when it does', async () => {
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, model: { provider: 'global-provider', model: 'global-model' },
      taskTypes: [type({ id: 'inherit', name: 'Inherit', model: null, directory: join(h.directory, 'inherit') }),
        type({ id: 'own', name: 'Own', model: { provider: 'own-provider', model: 'own-model' }, directory: join(h.directory, 'own') })] } })

    const inherited = await accept(feishu('6', '@bot documented default'), 'inherit')
    const own = await accept(feishu('7', '@bot documented own'), 'own')

    expect(inherited.execution!.model).toEqual({ provider: 'global-provider', model: 'global-model' })
    expect(own.execution!.model).toEqual({ provider: 'own-provider', model: 'own-model' })
  })

  it('runs a fixed type in its own directory and skips the prepare command', async () => {
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, prepare: 'exit 1', taskTypes: [type({ id: 'docs' })] } })
    h.subprocess.spawn.mockClear()

    const ticket = await accept(feishu('8', '@bot document this'), 'docs')

    expect(ticket.execution).toMatchObject({ taskType: 'docs', directoryMode: 'fixed', directory: join(h.directory, 'docs') })
    expect(h.subprocess.spawn.mock.calls.some(([spec]) => (spec as { argv: string[] }).argv.join(' ').includes('exit 1'))).toBe(false)
  })

  it('keeps the legacy single directory when no task types are configured', async () => {
    const ticket = await accept(feishu('9', '@bot fix this'))

    expect(ticket.execution).not.toHaveProperty('taskType')
    expect(ticket.execution!.directory).toBe(join(h.directory, 'work', `fix-test-${ticket.id.slice(0, 12)}`))
  })

  it('requires a type for an operator task and exposes the required-classification rule to the sorter prompt', async () => {
    seedTypes([type({ id: 'docs', name: 'Docs' })])
    const untyped = await h.runTool(h.runtime.masterId, 'orchestrator_task_start', { tasks: [{ title: 'Docs', request: 'write docs' }] }) as
      { started: { refused?: string }[] }
    expect(untyped.started[0]!.refused).toMatch(/Work cannot proceed unclassified/)
    const started = await h.runTool(h.runtime.masterId, 'orchestrator_task_start', { tasks: [{ title: 'Docs', request: 'write docs',
      taskType: 'docs' }] }) as { started: { ticket: { ticket_id: string } }[] }
    await h.runtime.idle()
    const ticket = h.runtime.store.tickets.get(started.started[0]!.ticket.ticket_id)!

    expect(ticket.execution).toMatchObject({ taskType: 'docs', taskTypeSource: 'explicit' })
    expect(h.runtime.prompts.preview(h.runtime.prompts.current().config).orchestrator)
      .toContain('Work cannot proceed unclassified: every accepted request and every accepted Eval decision must name one of these ids')
  })

  it('filters the open Ticket list by the accepted task type', async () => {
    seedTypes([type({ id: 'docs', name: 'Docs' }), type({ id: 'code', name: 'Code', directory: join(h.directory, 'code') })])
    const docs = await accept(feishu('10', '@bot document the endpoint'), 'docs')
    const code = await accept(feishu('11', '@bot fix the code'), 'code')

    const listed = await h.api('GET', 'tickets?state=open') as unknown as { body: { items: { id: string }[] } }
    expect(listed.body.items.map(item => item.id).sort()).toEqual([docs.id, code.id].sort())
    const filtered = await h.api('GET', 'tickets?state=open&taskType=docs') as unknown as { body: { items: { id: string }[] } }
    expect(filtered.body.items.map(item => item.id)).toEqual([docs.id])
  })

  it('reads and writes task types through settings/executor', async () => {
    const before = await h.api('GET', 'settings/executor') as unknown as { body: { revision: number; value: { taskTypes: unknown[] } } }
    expect(before.body.value.taskTypes).toEqual([])
    const value = { ...(before.body.value as object), taskTypes: [type({ id: 'docs' })] }
    const saved = await h.api('PUT', 'settings/executor', { value, revision: before.body.revision }) as unknown as { status: number }
    expect(saved.status).toBe(200)
    const after = await h.api('GET', 'settings/executor') as unknown as { body: { value: { taskTypes: { id: string }[]; defaultTaskType?: string } } }
    expect(after.body.value.taskTypes.map(item => item.id)).toEqual(['docs'])
    expect(after.body.value).not.toHaveProperty('defaultTaskType')
  })

  it('defaults every type to writable and snapshots a read-only type for its tickets', async () => {
    expect(TaskTypeSchema.parse({ id: 'docs', name: 'Docs', description: 'Docs.', directory: join(h.directory, 'docs') }).readOnly).toBe(false)
    seedTypes([type({ id: 'consult', name: 'Consult', readOnly: true }), type({ id: 'docs', name: 'Docs' })])

    const readonly = await accept(feishu('12', '@bot answer this'), 'consult')
    const writable = await accept(feishu('13', '@bot write the docs'), 'docs')

    expect(readonly.execution).toMatchObject({ taskType: 'consult', readOnly: true })
    expect(writable.execution).not.toHaveProperty('readOnly')
  })

  it('runs a read-only type\'s worker with only the skills and BQA retrieval tools, under the read-only preset, approvals disabled', async () => {
    seedTypes([type({ id: 'consult', name: 'Consult', readOnly: true })])

    const ticket = await accept(feishu('14', '@bot answer this'), 'consult')
    const sessionId = `worker-${ticket.id}`

    expect(h.permissionPresets.set).toHaveBeenCalledWith(expect.objectContaining({ id: sessionId }), 'read-only')
    expect(h.approval.setPolicy).toHaveBeenCalledWith(expect.objectContaining({ id: sessionId }), 'never')
    // Its Session is created with the read-only agent preset, which has no shell, file, web or delegation tools.
    const created = h.controller.create.mock.calls.find(([options]) => options.sessionId === sessionId)!
    expect(created[0]).toMatchObject({ agentPreset: 'dsh-superagent-worker-readonly' })
    // The allow mask keeps only the tools that preset registers: the skill here; the BQA MCP tools appear after MCP startup.
    expect(h.restricted.get(sessionId)!.at(-1)!.allow).toEqual(['skill'])
    // A writable type keeps every profile work tool it has.
    seedTypes([type({ id: 'work', name: 'Work' })])
    const writable = await accept(feishu('15', '@bot write the docs'), 'work')
    expect(h.restricted.get(`worker-${writable.id}`)!.at(-1)!.allow).toEqual(expect.arrayContaining(['write', 'edit']))
  })

  it('offers a read-only worker only skills and the BQA read-only retrieval tools', () => {
    expect(workToolsFor(true)).toEqual(['skill', 'mcp__bqa__search_knowledge', 'mcp__bqa__search_code', 'mcp__bqa__read_excerpt'])
    expect(workToolsFor(true)).not.toContain('write')
    expect(workToolsFor(true)).not.toContain('pwsh')
    expect(workToolsFor(false)).toEqual(expect.arrayContaining(['read', 'write', 'edit', 'bash', 'subagent']))
  })
})
