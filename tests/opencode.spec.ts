/** Pure protocol mappings of the native opencode ACP driver: tool names, approvals, elicitation forms, stop reasons and bin resolution. */
import { afterEach, describe, expect, it } from 'vitest'
import {
  assistantContent, elicitationAnswers, isChildUpdate, opencodeToolName, permissionChoice, questionsFromElicitation,
  resolveOpencodeBin, sameCwd, stopReasonOutcome, toolResultFromUpdate,
} from '../src/executor/opencode.ts'
import { opencodeSettingsForTicket } from '../src/app/executor-profile.ts'
import { permissionQuestion } from '../src/executor/native-shared.ts'
import { ExecutorConfigSchema, SettingsSchema, TaskTypeSchema } from '../src/policy.ts'
import type { Ticket } from '../src/core/index.ts'

const elicitationForm = {
  mode: 'form',
  sessionId: 'ses_1',
  toolCallId: 'call_q',
  message: 'Questions',
  requestedSchema: {
    type: 'object',
    properties: {
      q0: {
        type: 'string',
        title: 'Color preference',
        description: 'Which color do you prefer?',
        oneOf: [
          { const: 'red', title: 'red', description: 'Prefer the color red' },
          { const: 'blue', title: 'blue', description: 'Prefer the color blue' },
        ],
      },
      q0_custom: { type: 'string', title: 'Color preference (other)', description: 'Type your own answer' },
    },
    required: [],
  },
}

describe('opencode tool names and approvals', () => {
  it('maps opencode tool names to the DSH names the panel renders', () => {
    expect(opencodeToolName('read')).toBe('read')
    expect(opencodeToolName('shell')).toBe('bash')
    expect(opencodeToolName('edit')).toBe('edit')
    expect(opencodeToolName('patch')).toBe('edit')
    expect(opencodeToolName('webfetch')).toBe('web_fetch')
    expect(opencodeToolName('websearch')).toBe('web_search')
    expect(opencodeToolName('task')).toBe('subagent')
    expect(opencodeToolName('skill')).toBe('skill')
    expect(opencodeToolName('question')).toBe('ask_user_question')
    // An MCP tool keeps the name its server gave it.
    expect(opencodeToolName('mcp__bqa__search')).toBe('mcp__bqa__search')
  })
  it('settles reads and searches under smart, and asks a person for writes, executions and the unknown', () => {
    for (const name of ['read', 'glob', 'grep', 'websearch', 'webfetch', 'skill']) {
      expect(permissionChoice({ name, kind: 'read' }, 'smart')).toBe('once')
    }
    for (const tool of [{ name: 'shell', kind: 'execute' }, { name: 'edit', kind: 'edit' }, { name: 'write', kind: 'edit' },
      { name: 'subagent', kind: 'other' }, { name: 'mcp__bqa__search', kind: 'other' }, { name: '', kind: 'other' }]) {
      expect(permissionChoice(tool, 'smart')).toBe('ask')
    }
    // A missing name may use the ACP kind; a named tool the bridge does not know never becomes automatic.
    expect(permissionChoice({ kind: 'search' }, 'smart')).toBe('once')
    expect(permissionChoice({ name: 'unknown_tool', kind: 'read' }, 'smart')).toBe('ask')
    expect(permissionChoice({ name: 'read' }, 'approve')).toBe('once')
    expect(permissionChoice({ name: 'read' }, 'deny')).toBe('reject')
    expect(permissionChoice({ name: 'read' }, 'ask')).toBe('ask')
  })
  it('builds the opencode permission card with Allow once and Reject, and says rejection ends the turn', () => {
    const question = permissionQuestion('shell', { command: 'git push origin main' },
      { engine: 'opencode', denyLabel: 'Reject', denyDescription: 'Refuse this call; opencode then ends the turn.' })
    expect(question.id).toBe('permission')
    expect(question.question).toContain('opencode wants to use shell')
    expect(question.question).toContain('git push origin main')
    expect(question.options?.map(option => option.label)).toEqual(['Allow once', 'Reject'])
    expect(question.options?.[1]?.description).toContain('ends the turn')
  })
})

describe('opencode elicitation mapping', () => {
  it('turns the form schema into one DSH question per property and keeps the custom field separate', () => {
    const mapped = questionsFromElicitation(elicitationForm)
    expect(mapped.questions).toEqual([{
      id: 'q0',
      question: 'Which color do you prefer?',
      header: 'Color preference',
      options: [{ label: 'red', description: 'Prefer the color red' }, { label: 'blue', description: 'Prefer the color blue' }],
    }])
    expect(mapped.fields).toHaveLength(1)
    expect(mapped.fields[0]).toMatchObject({ key: 'q0', multiSelect: false, customKey: 'q0_custom' })
    // The message is always "Questions"; it must not become the card's question text.
    expect(mapped.questions[0]!.question).not.toBe('Questions')
  })
  it('maps answers back to the schema values, custom text included, and declines an empty answer', () => {
    const { fields } = questionsFromElicitation(elicitationForm)
    expect(elicitationAnswers(fields, [{ id: 'q0', selected: ['blue'] }])).toEqual({ action: 'accept', content: { q0: 'blue' } })
    expect(elicitationAnswers(fields, [{ id: 'q0', selected: ['blue'], custom: 'teal' }]))
      .toEqual({ action: 'accept', content: { q0: 'blue', q0_custom: 'teal' } })
    // A custom answer alone still carries a valid const for the field.
    expect(elicitationAnswers(fields, [{ id: 'q0', selected: [], custom: 'teal' }]))
      .toEqual({ action: 'accept', content: { q0: 'red', q0_custom: 'teal' } })
    expect(elicitationAnswers(fields, [])).toEqual({ action: 'decline' })
    expect(elicitationAnswers(fields, [{ id: 'q0', selected: [] }])).toEqual({ action: 'decline' })
  })
  it('maps a multi-value field to an array of const values', () => {
    const mapped = questionsFromElicitation({ requestedSchema: { type: 'object', properties: {
      files: { type: 'array', title: 'Files', description: 'Which files?', oneOf: [{ const: 'a.ts', title: 'a.ts' }, { const: 'b.ts', title: 'b.ts' }] },
    } } })
    expect(mapped.questions[0]?.multiSelect).toBe(true)
    expect(elicitationAnswers(mapped.fields, [{ id: 'files', selected: ['a.ts', 'b.ts'] }]))
      .toEqual({ action: 'accept', content: { files: ['a.ts', 'b.ts'] } })
  })
})

describe('opencode turn mapping', () => {
  it('maps every ACP stopReason onto the DSH step ending', () => {
    expect(stopReasonOutcome('end_turn', false)).toEqual({ end: { kind: 'completed' } })
    expect(stopReasonOutcome('max_tokens', false)).toEqual({ end: { kind: 'max-tokens' } })
    expect(stopReasonOutcome('max_turn_requests', false)).toEqual({ end: { kind: 'max-tokens' } })
    expect(stopReasonOutcome('cancelled', true)).toEqual({ abort: true })
    // A person rejecting a card ends the turn; it must not fail the ticket as an unknown failure.
    expect(stopReasonOutcome('cancelled', false)).toEqual({ end: { kind: 'completed' } })
    expect(stopReasonOutcome('refusal', false)).toMatchObject({ failure: expect.stringContaining('refusal') })
    expect(stopReasonOutcome(undefined, false)).toMatchObject({ failure: expect.stringContaining('no stopReason') })
  })
  it('merges thinking before the visible text and strips the worker report from it', () => {
    const mapped = assistantContent('plan', 'Hello\nDSH_REPORT {"state":"ready","summary":"Done"}')
    expect(mapped.content).toEqual([{ type: 'reasoning', text: 'plan' }, { type: 'text', text: 'Hello' }])
    expect(mapped.report).toEqual({ state: 'ready', summary: 'Done' })
    expect(assistantContent('', '').content).toEqual([])
  })
  it('maps a finished tool call to DSH result content, including errors and diff previews', () => {
    expect(toolResultFromUpdate({
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'Read file README.md' } }],
      rawOutput: { metadata: { truncated: false } },
    })).toEqual({ content: [{ type: 'text', text: 'Read file README.md' }], isError: false })
    expect(toolResultFromUpdate({
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: 'The user declined this tool call' } }],
      rawOutput: { error: 'The user declined this tool call' },
    })).toMatchObject({ isError: true, content: expect.arrayContaining([{ type: 'text', text: 'The user declined this tool call' }]) })
    const diff = toolResultFromUpdate({ status: 'completed', content: [{ type: 'diff', path: 'src/a.ts', oldText: 'old', newText: 'new' }] })
    expect(diff.content[0]).toMatchObject({ type: 'text' })
    expect((diff.content[0] as { text: string }).text).toContain('src/a.ts')
    expect(diff.isError).toBe(false)
  })
  it('recognizes a child-session update from its `_meta`', () => {
    expect(isChildUpdate({ _meta: { 'opencode/child-session': { id: 'ses_child', parentID: 'ses_1', depth: 1 } } })).toBe(true)
    expect(isChildUpdate({ _meta: {} })).toBe(false)
    expect(isChildUpdate({})).toBe(false)
  })
})

describe('opencode session and executable resolution', () => {
  const saved = process.env.OPENCODE_BIN
  afterEach(() => {
    if (saved === undefined) delete process.env.OPENCODE_BIN
    else process.env.OPENCODE_BIN = saved
  })
  it('prefers an explicit executable, then OPENCODE_BIN, then the Windows npm install or PATH', () => {
    expect(resolveOpencodeBin('C:/tools/opencode.exe')).toBe('C:/tools/opencode.exe')
    process.env.OPENCODE_BIN = 'C:/env/opencode.exe'
    expect(resolveOpencodeBin('')).toBe('C:/env/opencode.exe')
    expect(resolveOpencodeBin('C:/tools/opencode.exe')).toBe('C:/tools/opencode.exe')
    delete process.env.OPENCODE_BIN
    const resolved = resolveOpencodeBin()
    if (process.platform === 'win32') {
      // The npm global install when present; otherwise the PATH name. Never the `.cmd` wrapper.
      expect(resolved.endsWith('opencode.exe') || resolved === 'opencode.exe').toBe(true)
      expect(resolved.endsWith('.cmd')).toBe(false)
    } else {
      expect(resolved).toBe('opencode')
    }
  })
  it('compares cwds the way the platform does', () => {
    expect(sameCwd('C:/work/t1', 'C:/work/t1')).toBe(true)
    if (process.platform === 'win32') expect(sameCwd('C:\\work\\T1', 'c:/work/t1')).toBe(true)
    expect(sameCwd('C:/work/t1', 'C:/work/t2')).toBe(false)
  })
  it('reads the opencode profile a Ticket snapshotted, or its type\'s when the Ticket predates the snapshot', () => {
    const settings = SettingsSchema.parse({ executor: { opencodeAgent: 'build', opencodeApproval: 'ask',
      opencodePermissionPreset: 'safe', taskTypes: [{ id: 'native', name: 'Native', description: 'Native work.', directory: 'C:\\w\\native',
        engine: 'opencode', opencode: { agent: 'type-agent', approval: 'deny' } }] } })
    const ticket = (execution: Record<string, unknown>): Ticket => ({ execution: { name: 'native-1', directory: 'C:\\w\\native',
      assignment: '', ...execution } }) as Ticket
    expect(opencodeSettingsForTicket(settings, ticket({ taskType: 'native' }))).toMatchObject({
      opencodeAgent: 'type-agent', opencodeApproval: 'deny', opencodePermissionPreset: 'safe' })
    expect(opencodeSettingsForTicket(settings, ticket({ taskType: 'native', engineOptions: { opencode: {
      agent: 'plan', approval: 'approve', permissionPreset: 'full', permissionRules: [] } } }))).toMatchObject({
      opencodeAgent: 'plan', opencodeApproval: 'approve', opencodePermissionPreset: 'full' })
  })
  it('keeps the schema defaults the panel will expose later', () => {
    const settings = ExecutorConfigSchema.parse({})
    expect(settings).toMatchObject({ opencodeBin: '', opencodeAgent: '', opencodeApproval: 'smart', opencodePermissionPreset: 'smart' })
    expect(TaskTypeSchema.parse({ id: 'native', name: 'Native', description: 'Native work.', directory: 'C:\\w\\native' }).opencode).toBeNull()
  })
})
