/** The native Claude Code driver over a fake stream-json process: turn projection, reports, questions, and permissions. */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { ClaudeCodeDriver, type ClaudeCodeOptions } from '../src/executor/claude-code.ts'
import { ExecutorConfigSchema } from '../src/policy.ts'
import { KV } from '../src/kv.ts'

/** One written stream-json line, as the fake process received it. */
type Line = Record<string, unknown>
/** A process the driver believes it started: a real pass-through pair for stdin and stdout. */
class FakeProcess extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = new PassThrough()
  readonly lines: Line[] = []
  onLine?: (line: Line) => void
  constructor() {
    super()
    this.stdin.setEncoding('utf8')
    let buffered = ''
    this.stdin.on('data', (chunk: string) => {
      buffered += chunk
      let at: number
      while ((at = buffered.indexOf('\n')) >= 0) {
        const text = buffered.slice(0, at)
        buffered = buffered.slice(at + 1)
        if (!text.trim()) continue
        const line = JSON.parse(text) as Line
        this.lines.push(line)
        this.onLine?.(line)
      }
    })
  }
  send(event: unknown): void { this.stdout.write(`${JSON.stringify(event)}\n`) }
  kill(): void { this.emit('exit', 0, null) }
}
interface Appended { type: string; data: Record<string, unknown>; seq: number }
/** A host around one driver: its fake process, Session log, and question service. `real` uses the configured Claude CLI in that directory. */
function harness(options: { answers?: unknown[]; stored?: boolean; real?: string; executor?: Record<string, unknown> } = {}) {
  const events: Appended[] = []
  const session = {
    append: (type: string, data: Record<string, unknown>) => { events.push({ type, data, seq: events.length }); return { seq: events.length - 1 } },
    requestHeader: () => undefined,
  }
  const execute = vi.fn(async (input: { name?: string; arguments?: { resource?: string } }) => input.name === 'orchestrator_read'
    ? { isError: false, content: [{ type: 'text', text: JSON.stringify({ resource: input.arguments?.resource, offset: 0,
      total_chars: 17, next_offset: null, text: 'FULL TRIGGER TEXT' }) }] }
    : { isError: false, content: [{ type: 'text', text: 'recorded' }] })
  const ask = vi.fn(async () => ({ answers: options.answers ?? [] }))
  const agent = {
    id: 'worker-t1', session, step: async (_decision: unknown) => ({ kind: 'completed' as const }),
    ctx: { tools: { get: () => ({}), execute } },
  }
  const store = new Map<string, unknown>()
  if (options.stored !== false) store.set(KV.sessions.claude('worker-t1'), { engine: 'claude-code', sessionId: 'cc-old' })
  const children: FakeProcess[] = []
  const spawnArgs: string[][] = []
  const spawnOptions: SpawnOptions[] = []
  const spawn = options.real ? undefined : (command: string, args: readonly string[], spawnOptionsIn: SpawnOptions) => {
    void command
    spawnArgs.push([...args])
    spawnOptions.push(spawnOptionsIn)
    const child = new FakeProcess()
    children.push(child)
    return child as unknown as ChildProcessWithoutNullStreams
  }
  const lifetime = new AbortController()
  const settings = ExecutorConfigSchema.parse(options.executor ?? {})
  const driver = new ClaudeCodeDriver({
    context: { get: (name: string) => name === 'userQuestions' ? { ask } : undefined, logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } },
    agent, ticket: { id: 't1', execution: { directory: options.real ?? 'C:/work/t1' } },
    store: {
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => { store.set(key, value) },
    },
    settings: () => settings, logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() }, lifetime: lifetime.signal,
    ...(spawn ? { spawn } : {}),
    environment: () => [{ key: 'DSH_SUPERAGENT_NAME', value: 'native-worker' }, { key: 'PATH', value: '/not-this' }],
  } as unknown as ClaudeCodeOptions)
  const detach = driver.attach()
  return {
    events, execute, ask, agent, store, children, spawnArgs, spawnOptions, driver, detach,
    get child() { return children.at(-1)! },
  }
}
/** Let the driver's queued stream callbacks and process handlers run. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return
    await settle()
  }
  throw new Error('The fake Claude Code process never reached the expected step')
}
const user = () => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Do the work' }] })
const decision = (signal: AbortSignal) => ({ messages: [user()], turn: 1, step: 1, signal })

describe('native Claude Code driver turns', () => {
  it('projects a turn, executes a terminal report, and strips it from the visible answer', async () => {
    const test = harness({ stored: false })
    const signal = new AbortController()
    const running = test.agent.step(decision(signal.signal)) as Promise<unknown>
    await until(() => test.child.lines.some(line => line.type === 'user'))
    expect(test.spawnArgs[0]).toEqual(expect.arrayContaining(['--print', '--input-format', 'stream-json', '--output-format',
      'stream-json', '--verbose', '--permission-prompt-tool=stdio', '--permission-prompts', 'host', '--permission-mode',
      'auto', '--append-system-prompt']))
    expect(test.spawnArgs[0]).not.toContain('--effort')
    expect(test.spawnOptions[0]!.env).toMatchObject({ CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', DSH_SUPERAGENT_NAME: 'native-worker' })
    expect(test.spawnOptions[0]!.env?.PATH).toBe(process.env.PATH)
    test.child.send({ type: 'system', subtype: 'init', session_id: 'cc-1', model: 'claude-sonnet-5-5' })
    test.child.send({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello\nDSH_REPORT {"state":"ready","summary":"Done"}' }] } })
    test.child.send({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', session_id: 'cc-1' })
    await expect(running).resolves.toEqual({ kind: 'completed' })
    const header = test.events.find(event => event.type === 'request/header')!.data.header as { tools: { parameters: { properties: object } }[] }
    expect(header.tools[0]!.parameters.properties).toHaveProperty('timeout')
    expect(test.events.filter(event => event.type === 'user/message')).toHaveLength(1)
    expect(test.events.find(event => event.type === 'assistant/message')!.data.message)
      .toMatchObject({ content: [{ type: 'text', text: 'Hello' }] })
    expect(test.execute).toHaveBeenCalledWith(expect.objectContaining({ name: 'orchestrator_report',
      arguments: { state: 'ready', summary: 'Done' } }))
    expect(test.store.get(KV.sessions.claude('worker-t1'))).toEqual({ engine: 'claude-code', sessionId: 'cc-1' })
    test.detach()
  })

  it('retries once in a fresh native session when --resume fails before init', async () => {
    const test = harness()
    const running = test.agent.step(decision(new AbortController().signal)) as Promise<unknown>
    await until(() => test.child.lines.some(line => line.type === 'control_request'))
    expect(test.spawnArgs[0]).toEqual(expect.arrayContaining(['--resume', 'cc-old']))
    test.child.emit('exit', 1, null)
    await until(() => test.children.length === 2 && test.child.lines.some(line => line.type === 'user'))
    expect(test.spawnArgs[1]).not.toContain('--resume')
    expect(test.events.filter(event => event.type === 'user/message')).toHaveLength(1)
    test.child.send({ type: 'system', subtype: 'init', session_id: 'cc-new', model: 'claude-sonnet-5-5' })
    test.child.send({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn' })
    await expect(running).resolves.toEqual({ kind: 'completed' })
    test.detach()
  })

  it('expands a card resource reference so the native worker sees the full request', async () => {
    const test = harness({ stored: false })
    const card = JSON.stringify({ ticket_id: 't1', trigger: { trigger_id: 'tr1', preview: 'short', read: 'trigger/tr1' } })
    const running = test.agent.step({ messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: card }] })],
      turn: 1, step: 1, signal: new AbortController().signal }) as Promise<unknown>
    await until(() => test.child.lines.some(line => line.type === 'user'))
    const sent = test.child.lines.find(line => line.type === 'user') as { message: { content: { text: string }[] } }
    expect(sent.message.content[0]!.text).toContain('<resource path="trigger/tr1">')
    expect(sent.message.content[0]!.text).toContain('FULL TRIGGER TEXT')
    expect(test.execute).toHaveBeenCalledWith(expect.objectContaining({ name: 'orchestrator_read',
      arguments: { resource: 'trigger/tr1', offset: 0, limit: 8000 } }))
    test.child.send({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn' })
    await expect(running).resolves.toEqual({ kind: 'completed' })
    test.detach()
  })

  it('bridges AskUserQuestion to a DSH question card and answers Claude by question text', async () => {
    const askInput = { questions: [{ header: 'Color', question: 'Which color?', multiSelect: false,
      options: [{ label: 'Red' }, { label: 'Blue' }] }] }
    const test = harness({ answers: [{ id: 'q1', selected: ['Blue'] }] })
    const signal = new AbortController()
    const running = test.agent.step(decision(signal.signal)) as Promise<unknown>
    const responses: Line[] = []
    test.child.onLine = line => {
      if (line.type !== 'control_response') return
      responses.push(line)
      test.child.send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_q',
        content: [{ type: 'text', text: 'answered' }] }] } })
      test.child.send({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn' })
    }
    await until(() => test.child.lines.some(line => line.type === 'user'))
    test.child.send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_q', name: 'AskUserQuestion',
      input: askInput }] } })
    test.child.send({ type: 'control_request', request_id: 'req-q', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion',
      input: askInput, tool_use_id: 'toolu_q' } })
    await expect(running).resolves.toEqual({ kind: 'completed' })
    expect(test.ask).toHaveBeenCalledWith(expect.objectContaining({ questions: [expect.objectContaining({ id: 'q1', question: 'Which color?' })],
      wait: { callId: 'toolu_q' } }))
    expect(responses[0]!.response).toEqual({ subtype: 'success', request_id: 'req-q', response: { behavior: 'allow',
      updatedInput: { ...askInput, answers: { 'Which color?': 'Blue' } } } })
    const calls = test.events.filter(event => event.type === 'tool/call')
    expect(calls.map(event => event.data.callId)).toEqual(['toolu_q'])
    const results = test.events.filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(1)
    expect(results[0]!.data.message).toMatchObject({ content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'q1', selected: ['Blue'] }] }) }] })
    test.detach()
  })

  it('asks a DSH approval card for a tool and logs the real result once', async () => {
    const test = harness({ answers: [{ id: 'permission', selected: ['Allow once'] }], executor: { claudeApproval: 'ask' } })
    const responses: Line[] = []
    const running = test.agent.step(decision(new AbortController().signal)) as Promise<unknown>
    test.child.onLine = line => {
      if (line.type !== 'control_response') return
      responses.push(line)
      test.child.send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_b',
        content: [{ type: 'text', text: 'ok' }] }] } })
      test.child.send({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn' })
    }
    await until(() => test.child.lines.some(line => line.type === 'user'))
    test.child.send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_b', name: 'Bash',
      input: { command: 'git status' } }] } })
    test.child.send({ type: 'control_request', request_id: 'req-b', request: { subtype: 'can_use_tool', tool_name: 'Bash',
      input: { command: 'git status' }, tool_use_id: 'toolu_b' } })
    await expect(running).resolves.toEqual({ kind: 'completed' })
    expect(test.ask).toHaveBeenCalledWith(expect.objectContaining({ questions: [expect.objectContaining({ id: 'permission' })],
      wait: { callId: 'permission:req-b' } }))
    expect(responses[0]!.response).toMatchObject({ response: { behavior: 'allow' } })
    const permissionResult = test.events.find(event => event.type === 'tool/result' && event.data.message &&
      (event.data.message as { toolCallId: string }).toolCallId === 'permission:req-b')
    expect(permissionResult).toBeDefined()
    const realResult = test.events.find(event => event.type === 'tool/result' && event.data.message &&
      (event.data.message as { toolCallId: string }).toolCallId === 'toolu_b')
    expect(realResult).toBeDefined()
    test.detach()
  })

  it('passes the configured effort level and Ultracode switch to the process', async () => {
    const test = harness({ stored: false, executor: { claudeEffort: 'max', claudeUltracode: true } })
    const running = test.agent.step(decision(new AbortController().signal)) as Promise<unknown>
    await until(() => test.child.lines.some(line => line.type === 'user'))
    expect(test.spawnArgs[0]).toEqual(expect.arrayContaining(['--effort', 'max', '--settings', '{"ultracode":true}']))
    test.child.send({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn' })
    await expect(running).resolves.toEqual({ kind: 'completed' })
    test.detach()
  })

  it('answers a tool that needs approval from the setting instead of a person', async () => {
    for (const [approval, behavior] of [['approve', 'allow'], ['deny', 'deny']] as const) {
      const test = harness({ executor: { claudeApproval: approval } })
      const responses: Line[] = []
      const running = test.agent.step(decision(new AbortController().signal)) as Promise<unknown>
      test.child.onLine = line => {
        if (line.type !== 'control_response') return
        responses.push(line)
        test.child.send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_b',
          content: [{ type: 'text', text: behavior === 'allow' ? 'ok' : 'denied' }] }] } })
        test.child.send({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn' })
      }
      await until(() => test.child.lines.some(line => line.type === 'user'))
      test.child.send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_b', name: 'Bash',
        input: { command: 'git status' } }] } })
      test.child.send({ type: 'control_request', request_id: 'req-b', request: { subtype: 'can_use_tool', tool_name: 'Bash',
        input: { command: 'git status' }, tool_use_id: 'toolu_b' } })
      await expect(running).resolves.toEqual({ kind: 'completed' })
      expect(test.ask).not.toHaveBeenCalled()
      expect(responses[0]!.response).toMatchObject({ subtype: 'success', request_id: 'req-b', response: { behavior } })
      test.detach()
    }
  })
})

// A paid, live turn through the configured Claude executable. Run with `CLAUDE_CODE_SMOKE=1` in a directory the
// native CLI already trusts; the ordinary suite stays offline.
const smoke = process.env.CLAUDE_CODE_SMOKE === '1' ? it : it.skip
describe('native Claude Code driver against the real CLI', () => {
  smoke('runs one real turn and records its terminal report', async () => {
    const test = harness({ stored: false, real: 'D:/hao11aiproject/envfixworkspace/probe' })
    const prompt = 'Do not use any tools. Reply with exactly "OK" on the first line, then on the second line: '
      + 'DSH_REPORT {"state":"ready","summary":"Smoke test"}'
    const running = test.agent.step({ messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] })],
      turn: 1, step: 1, signal: new AbortController().signal }) as Promise<unknown>
    await expect(running).resolves.toEqual({ kind: 'completed' })
    const visible = test.events.filter(event => event.type === 'assistant/message')
      .map(event => JSON.stringify(event.data.message)).join('\n')
    expect(visible).toContain('OK')
    expect(visible).not.toContain('DSH_REPORT')
    expect(test.execute).toHaveBeenCalledWith(expect.objectContaining({ name: 'orchestrator_report',
      arguments: expect.objectContaining({ state: 'ready', summary: 'Smoke test' }) }))
    expect(test.store.get(KV.sessions.claude('worker-t1'))).toMatchObject({ engine: 'claude-code' })
    test.detach()
  }, 180_000)
})
