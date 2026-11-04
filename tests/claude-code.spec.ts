/** Pure protocol mappings of the native Claude Code worker bridge: questions, answers, permissions, reports, and content. */
import { describe, expect, it } from 'vitest'
import { answersForClaude, displayToolName, mapAssistantContent, parseWorkerReport, permissionQuestion, questionsFromClaude,
  resolveClaudeBin, stripWorkerReport, toolArguments, toolResultContent } from '../src/executor/claude-code.ts'

const askInput = {
  questions: [
    { header: 'Color', question: 'Which color do you prefer?', multiSelect: false, options: [{ label: 'Red', description: 'Choose red.' }, { label: 'Blue' }] },
    { question: 'Which files?', multiSelect: true, options: [{ label: 'a.ts' }, { label: 'b.ts' }] },
  ],
}

describe('Claude question mapping', () => {
  it('gives Claude questions stable DSH ids and keeps the tool/service spellings', () => {
    const mapped = questionsFromClaude(askInput)
    expect(mapped.service).toEqual([
      { id: 'q1', question: 'Which color do you prefer?', header: 'Color', options: [{ label: 'Red', description: 'Choose red.' }, { label: 'Blue' }] },
      { id: 'q2', question: 'Which files?', options: [{ label: 'a.ts' }, { label: 'b.ts' }], multiSelect: true },
    ])
    expect(mapped.tool[1]).toMatchObject({ id: 'q2', multi_select: true })
    expect(mapped.texts).toEqual(['Which color do you prefer?', 'Which files?'])
  })
  it('falls back to a readable question when Claude sends none', () => {
    const mapped = questionsFromClaude({ questions: [] })
    expect(mapped.service).toHaveLength(1)
    expect(mapped.texts).toEqual([''])
  })
  it('returns answers keyed by question text, joining multi-select and custom values', () => {
    const mapped = questionsFromClaude(askInput)
    expect(answersForClaude(mapped.service, mapped.texts, [
      { id: 'q1', selected: ['Blue'] },
      { id: 'q2', selected: ['a.ts', 'b.ts'], custom: 'c.ts' },
    ])).toEqual({ 'Which color do you prefer?': 'Blue', 'Which files?': 'a.ts, b.ts, c.ts' })
    expect(answersForClaude(mapped.service, mapped.texts, [])).toEqual({ 'Which color do you prefer?': '', 'Which files?': '' })
  })
  it('normalizes AskUserQuestion tool arguments and leaves other tools raw', () => {
    expect(JSON.parse(toolArguments('AskUserQuestion', askInput))).toEqual({
      questions: [
        { id: 'q1', question: 'Which color do you prefer?', header: 'Color', options: [{ label: 'Red', description: 'Choose red.' }, { label: 'Blue' }] },
        { id: 'q2', question: 'Which files?', options: [{ label: 'a.ts' }, { label: 'b.ts' }], multi_select: true },
      ],
    })
    expect(toolArguments('Bash', { command: 'git status' })).toBe('{"command":"git status"}')
  })
  it('maps Claude tool names to the names the DSH panel renders', () => {
    expect(displayToolName('Bash')).toBe('bash')
    expect(displayToolName('AskUserQuestion')).toBe('ask_user_question')
    expect(displayToolName('SomeMcpTool')).toBe('SomeMcpTool')
  })
})

describe('Claude permission mapping', () => {
  it('shows the command and offers Allow once and Deny', () => {
    const question = permissionQuestion('Bash', { command: 'git push origin main' })
    expect(question.id).toBe('permission')
    expect(question.question).toContain('git push origin main')
    expect(question.options?.map(option => option.label)).toEqual(['Allow once', 'Deny'])
  })
  it('falls back to the JSON input when no familiar field describes the call', () => {
    expect(permissionQuestion('Mystery', { a: 1 }).question).toContain('{"a":1}')
  })
})

describe('Claude content mapping', () => {
  it('maps text, reasoning, and tool calls, stripping a worker report', () => {
    const mapped = mapAssistantContent([
      { type: 'thinking', thinking: 'plan' },
      { type: 'text', text: 'Finished.\nDSH_REPORT {"state":"ready","summary":"Done."}' },
      { type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'true' } },
    ])
    expect(mapped.report).toEqual({ state: 'ready', summary: 'Done.' })
    expect(mapped.content).toEqual([
      { type: 'reasoning', text: 'plan' },
      { type: 'text', text: 'Finished.' },
      { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"true"}' },
    ])
  })
  it('maps tool result content, replacing images with a marker', () => {
    expect(toolResultContent('ok')).toEqual([{ type: 'text', text: 'ok' }])
    expect(toolResultContent([{ type: 'text', text: 'a' }, { type: 'image', source: {} }]))
      .toEqual([{ type: 'text', text: 'a' }, { type: 'text', text: '[image]' }])
    expect(toolResultContent(undefined)).toEqual([{ type: 'text', text: '' }])
  })
  it('parses only known, nonempty worker reports', () => {
    expect(parseWorkerReport({ state: 'blocked', summary: 'Need a key', human_action: 'Provide one' }))
      .toEqual({ state: 'blocked', summary: 'Need a key', human_action: 'Provide one' })
    expect(parseWorkerReport({ state: 'unknown', summary: 'x' })).toBeUndefined()
    expect(parseWorkerReport({ state: 'ready', summary: ' ' })).toBeUndefined()
    expect(parseWorkerReport({ state: 'ready', summary: 'x', pr_number: 0 })).toEqual({ state: 'ready', summary: 'x' })
  })
  it('leaves ordinary text untouched and removes only report lines', () => {
    expect(stripWorkerReport('One line\n\nAnother')).toEqual({ text: 'One line\n\nAnother' })
    expect(stripWorkerReport('Work\nDSH_REPORT {"state":"dropped","summary":"Nothing to do"}')).toEqual({
      text: 'Work', report: { state: 'dropped', summary: 'Nothing to do' },
    })
  })
})

describe('Claude executable resolution', () => {
  it('uses an explicitly configured executable', () => {
    expect(resolveClaudeBin('/opt/claude')).toBe('/opt/claude')
  })
})
