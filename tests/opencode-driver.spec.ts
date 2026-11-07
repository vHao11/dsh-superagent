/** The native opencode ACP driver over a fake JSON-RPC peer: turns, reports, tools, permissions, questions, cancel, and resume. */
import type { ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { OpencodeDriver, type OpencodeOptions } from '../src/executor/opencode.ts'
import { BRIDGE_PROMPT } from '../src/executor/native-shared.ts'
import { ExecutorConfigSchema } from '../src/policy.ts'
import { KV } from '../src/kv.ts'
import type { Ticket } from '../src/core/index.ts'
import { FakeAcpError, FakeAcpServer, acpConfigOptions, waitFor, type AcpScript } from './fake-acp.ts'

interface Appended { type: string; data: Record<string, unknown>; seq: number; options?: Record<string, unknown> }
const quiet = () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn() })

/** A host around one driver: its scripted ACP servers, Session log, question service and spawn seam. */
function harness(options: { answers?: unknown[]; stored?: { sessionId?: string; cwd?: string } | false; executor?: Record<string, unknown>
  script?: AcpScript; directory?: string; real?: string; model?: { provider: string; model: string; reasoningEffort?: string } | null;
  instructions?: () => string } = {}) {
  const directory = options.real ?? options.directory ?? 'C:/work/t1'
  const events: Appended[] = []
  const session = {
    append: (type: string, data: Record<string, unknown>, options?: Record<string, unknown>) => {
      events.push({ type, data, seq: events.length, ...(options ? { options } : {}) })
      return { seq: events.length - 1 }
    },
    requestHeader: () => undefined,
  }
  const execute = vi.fn(async (input: { name?: string; arguments?: { resource?: string } }) => input.name === 'orchestrator_read'
    ? { isError: false, content: [{ type: 'text', text: JSON.stringify({ resource: input.arguments?.resource, offset: 0,
      total_chars: 17, next_offset: null, text: 'FULL TRIGGER TEXT' }) }] }
    : { isError: false, content: [{ type: 'text', text: 'recorded' }] })
  const ask = vi.fn(async (request: { signal?: AbortSignal }) => {
    if (request.signal?.aborted) throw new Error('The question was cancelled')
    return { answers: options.answers ?? [] }
  })
  const agent = {
    id: 'worker-t1', session, step: async (_decision: unknown) => ({ kind: 'completed' as const }),
    ctx: { tools: { get: () => ({}), execute } },
  }
  const store = new Map<string, unknown>()
  if (options.stored !== false) {
    store.set(KV.sessions.opencode('worker-t1'), { engine: 'opencode',
      sessionId: options.stored?.sessionId ?? 'ses_old', cwd: options.stored?.cwd ?? directory })
  }
  const servers: FakeAcpServer[] = []
  const spawnArgs: string[][] = []
  const commands: string[] = []
  const spawnOptions: SpawnOptions[] = []
  const spawn = (command: string, args: readonly string[], spawnOptionsIn: SpawnOptions) => {
    const server = new FakeAcpServer(options.script ?? {})
    servers.push(server)
    commands.push(command)
    spawnArgs.push([...args])
    spawnOptions.push(spawnOptionsIn)
    return server.child as unknown as ChildProcessWithoutNullStreams
  }
  const lifetime = new AbortController()
  const settings = ExecutorConfigSchema.parse({ opencodeApproval: 'ask', ...options.executor })
  const logger = quiet()
  const driver = new OpencodeDriver({
    context: { get: (name: string) => name === 'userQuestions' ? { ask } : undefined, logger },
    agent, ticket: { id: 't1', execution: { directory } } as Ticket,
    store: { get: (key: string) => store.get(key), set: (key: string, value: unknown) => { store.set(key, value) } },
    settings: () => settings, logger, lifetime: lifetime.signal, ...(options.real ? {} : { spawn }),
    ...(options.model !== undefined ? { model: () => options.model ?? null } : {}),
    ...(options.instructions ? { instructions: options.instructions } : {}),
    environment: () => [{ key: 'DSH_SUPERAGENT_NAME', value: 'native-worker' }, { key: 'PATH', value: '/not-this' }],
  } as unknown as OpencodeOptions)
  const detach = driver.attach()
  return {
    directory, events, execute, ask, agent, store, servers, spawnArgs, commands, spawnOptions, driver, detach,
    get server() { return servers.at(-1)! },
  }
}

const user = () => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Do the work' }] })
const decision = (signal: AbortSignal, messages = [user()]) => ({ messages, turn: 1, step: 1, signal })
const assistantTexts = (events: Appended[]): unknown[] => events.filter(event => event.type === 'assistant/message')
  .map(event => (event.data.message as { content: unknown }).content)

describe('native opencode driver turns', () => {
  it('projects a turn, executes a terminal report, and strips it from the visible answer', async () => {
    const script: AcpScript = {
      prompt: (server) => {
        server.update({ sessionUpdate: 'agent_thought_chunk', messageId: 'msg_1:reasoning:0', content: { type: 'text', text: 'plan' } })
        server.update({ sessionUpdate: 'agent_message_chunk', messageId: 'msg_1',
          content: { type: 'text', text: 'Hello\nDSH_REPORT {"state":"ready","summary":"Done"}' } })
        server.update({ sessionUpdate: 'usage_update', used: 18_726, size: 1_000_000, cost: { amount: 0, currency: 'USD' } })
        server.promptResponse('end_turn', { inputTokens: 1, outputTokens: 2, totalTokens: 3 })
      },
    }
    const test = harness({ stored: false, script, instructions: () => 'WORKER INSTRUCTIONS: follow the ticket policy.' })
    const running = test.agent.step(decision(new AbortController().signal))
    await expect(running).resolves.toEqual({ kind: 'completed' })

    expect(test.spawnArgs[0]).toEqual(['acp'])
    expect(test.spawnOptions[0]!.cwd).toBe(test.directory)
    expect(test.spawnOptions[0]!.env).toMatchObject({ OPENCODE_DISABLE_AUTOUPDATE: '1', DSH_SUPERAGENT_NAME: 'native-worker' })
    expect(test.spawnOptions[0]!.env?.PATH).toBe(process.env.PATH)
    const initialize = test.server.process.written('initialize')[0]!.params as {
      protocolVersion: number; clientCapabilities: { fs: unknown; terminal: unknown; elicitation: unknown; _meta: unknown } }
    expect(initialize.protocolVersion).toBe(1)
    expect(initialize.clientCapabilities.fs).toEqual({ readTextFile: false, writeTextFile: false })
    expect(initialize.clientCapabilities.terminal).toBe(false)
    // ACP needs the object to advertise form elicitation; a boolean makes opencode's questions unshowable.
    expect(initialize.clientCapabilities.elicitation).toEqual({ form: {} })
    expect(initialize.clientCapabilities._meta).toEqual({ 'opencode/child-session-updates': true })
    expect(test.server.process.written('session/new')[0]!.params).toEqual({ cwd: test.directory, mcpServers: [] })

    const prompts = test.server.prompts[0]!.prompt as { type: string; text: string }[]
    expect(prompts[0]!.text.startsWith(BRIDGE_PROMPT)).toBe(true)
    expect(prompts[0]!.text).toContain('WORKER INSTRUCTIONS: follow the ticket policy.')
    expect(prompts[0]!.text).toContain('Do the work')
    expect(test.events.filter(event => event.type === 'user/message')).toHaveLength(1)
    expect(assistantTexts(test.events)).toEqual([[{ type: 'reasoning', text: 'plan' }, { type: 'text', text: 'Hello' }]])
    expect(test.execute).toHaveBeenCalledWith(expect.objectContaining({ name: 'orchestrator_report',
      arguments: { state: 'ready', summary: 'Done' } }))
    expect(test.events.filter(event => event.type === 'tool/call' && event.data.callId === 'opencode-report:1')).toHaveLength(1)
    expect(test.store.get(KV.sessions.opencode('worker-t1'))).toEqual({ engine: 'opencode', sessionId: 'ses_new', cwd: test.directory })
    test.detach()
  })

  it('projects a tool call at its in-progress update and its result when it completes', async () => {
    const script: AcpScript = {
      prompt: (server) => {
        server.update({ sessionUpdate: 'tool_call', toolCallId: 'call_1', name: 'read', title: 'read', kind: 'read', status: 'pending',
          locations: [], rawInput: {} })
        server.update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'in_progress', kind: 'read',
          locations: [{ path: `${test.directory}/README.md` }], rawInput: { path: 'README.md' } })
        server.update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'Read file README.md' } }], rawOutput: { metadata: { truncated: false } } })
        server.update({ sessionUpdate: 'agent_message_chunk', messageId: 'msg_2', content: { type: 'text', text: 'It says hi.' } })
        server.promptResponse('end_turn')
      },
    }
    const test = harness({ stored: false, script })
    await expect(test.agent.step(decision(new AbortController().signal))).resolves.toEqual({ kind: 'completed' })

    const calls = test.events.filter(event => event.type === 'tool/call')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.data).toMatchObject({ callId: 'call_1', name: 'read', arguments: '{"path":"README.md"}' })
    const results = test.events.filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(1)
    expect(results[0]!.data).toMatchObject({ message: { toolCallId: 'call_1', isError: false,
      content: [{ type: 'text', text: 'Read file README.md' }] } })
    expect(results[0]!.options).toMatchObject({ surfaceOp: 'append', sourceEventSeqs: [calls[0]!.seq] })
    test.detach()
  })

  it('asks a DSH approval card for a shell call and answers opencode once', async () => {
    const script: AcpScript = {
      prompt: async (server) => {
        server.update({ sessionUpdate: 'tool_call', toolCallId: 'call_b', name: 'shell', title: 'shell', kind: 'execute', status: 'pending',
          locations: [], rawInput: {} })
        server.update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_b', status: 'in_progress', kind: 'execute',
          locations: [{ path: test.directory }], rawInput: { command: 'git status' } })
        const id = server.request('session/request_permission', { sessionId: 'ses_new', toolCall: { toolCallId: 'call_b', name: 'shell',
          title: 'git status', kind: 'execute', status: 'pending', locations: [{ path: test.directory }], rawInput: { command: 'git status' } },
        options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
          { optionId: 'reject', kind: 'reject_once', name: 'Reject' }] })
        const response = await server.waitResponse(id)
        expect(response.result).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
        server.update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_b', status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: '## main' } }], rawOutput: { metadata: { exit: 0 } } })
        server.update({ sessionUpdate: 'agent_message_chunk', messageId: 'msg_3', content: { type: 'text', text: 'Clean.' } })
        server.promptResponse('end_turn')
      },
    }
    const test = harness({ stored: false, script, answers: [{ id: 'permission', selected: ['Allow once'] }] })
    await expect(test.agent.step(decision(new AbortController().signal))).resolves.toEqual({ kind: 'completed' })

    expect(test.ask).toHaveBeenCalledWith(expect.objectContaining({ wait: { callId: 'permission:0' },
      questions: [expect.objectContaining({ id: 'permission', header: 'Tool permission',
        question: expect.stringContaining('git status'), options: [expect.objectContaining({ label: 'Allow once' }),
          expect.objectContaining({ label: 'Reject' })] })] }))
    const cardCall = test.events.find(event => event.type === 'tool/call' && event.data.callId === 'permission:0')
    expect(cardCall).toMatchObject({ data: { name: 'ask_user_question' } })
    const cardResult = test.events.find(event => event.type === 'tool/result'
      && (event.data.message as { toolCallId: string }).toolCallId === 'permission:0')
    expect(cardResult).toMatchObject({ data: { message: { isError: false } } })
    expect(test.events.filter(event => event.type === 'tool/result'
      && (event.data.message as { toolCallId: string }).toolCallId === 'call_b')).toHaveLength(1)
    test.detach()
  })

  it('settles a read under smart without a person, and still asks for a shell', async () => {
    const read = harness({ stored: false, executor: { opencodeApproval: 'smart' }, script: {
      prompt: async (server) => {
        const id = server.request('session/request_permission', { sessionId: 'ses_new',
          toolCall: { toolCallId: 'call_r', name: 'read', kind: 'read', status: 'pending', rawInput: { path: 'README.md' } },
          options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject' }] })
        const response = await server.waitResponse(id)
        expect(response.result).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
        server.promptResponse('end_turn')
      },
    } })
    await expect(read.agent.step(decision(new AbortController().signal))).resolves.toEqual({ kind: 'completed' })
    expect(read.ask).not.toHaveBeenCalled()
    expect(read.events.filter(event => event.type === 'tool/call')).toHaveLength(0)
    read.detach()

    const shell = harness({ stored: false, executor: { opencodeApproval: 'smart' }, answers: [{ id: 'permission', selected: ['Allow once'] }],
      script: {
        prompt: async (server) => {
          const id = server.request('session/request_permission', { sessionId: 'ses_new',
            toolCall: { toolCallId: 'call_s', name: 'shell', kind: 'execute', status: 'pending', rawInput: { command: 'npm test' } },
            options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject' }] })
          await server.waitResponse(id)
          server.promptResponse('end_turn')
        },
      } })
    await expect(shell.agent.step(decision(new AbortController().signal))).resolves.toEqual({ kind: 'completed' })
    expect(shell.ask).toHaveBeenCalled()
    shell.detach()
  })

  it('ends the turn without failing the ticket when a person rejects the permission', async () => {
    const script: AcpScript = {
      prompt: async (server) => {
        const id = server.request('session/request_permission', { sessionId: 'ses_new',
          toolCall: { toolCallId: 'call_d', name: 'edit', kind: 'edit', status: 'pending', rawInput: { path: 'src/a.ts' } },
          options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject' }] })
        expect((await server.waitResponse(id)).result).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } })
        server.update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_d', status: 'failed',
          content: [{ type: 'content', content: { type: 'text', text: 'The user declined this tool call' } }],
          rawOutput: { error: 'The user declined this tool call' } })
        // The whole prompt turn ends: opencode does not continue the model after a rejection.
        server.promptResponse('cancelled')
      },
    }
    const test = harness({ stored: false, script, answers: [{ id: 'permission', selected: ['Reject'] }] })
    await expect(test.agent.step(decision(new AbortController().signal))).resolves.toEqual({ kind: 'completed' })
    const cardResult = test.events.find(event => event.type === 'tool/result'
      && (event.data.message as { toolCallId: string }).toolCallId === 'permission:0')
    expect(cardResult).toMatchObject({ data: { message: { isError: true } } })
    test.detach()
  })

  it('bridges an elicitation form into one question card and answers it in the same turn', async () => {
    const schema = {
      type: 'object',
      properties: {
        q0: { type: 'string', title: 'Color preference', description: 'Which color do you prefer?',
          oneOf: [{ const: 'red', title: 'red', description: 'Prefer the color red' },
            { const: 'blue', title: 'blue', description: 'Prefer the color blue' }] },
        q0_custom: { type: 'string', title: 'Color preference (other)', description: 'Type your own answer' },
      },
      required: [],
    }
    const script: AcpScript = {
      prompt: async (server) => {
        server.update({ sessionUpdate: 'tool_call', toolCallId: 'call_q', name: 'question', title: 'question', kind: 'other',
          status: 'pending', locations: [], rawInput: {} })
        server.update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_q', status: 'in_progress', kind: 'other', title: 'question',
          rawInput: { questions: [{ question: 'Which color do you prefer?', header: 'Color preference' }] } })
        const id = server.request('elicitation/create', { mode: 'form', sessionId: 'ses_new', toolCallId: 'call_q', message: 'Questions',
          requestedSchema: schema })
        const response = await server.waitResponse(id)
        expect(response.result).toEqual({ action: 'accept', content: { q0: 'blue', q0_custom: 'teal' } })
        server.update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_q', status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'User has answered your questions' } }],
          rawOutput: { metadata: { answers: [['blue']] } } })
        server.update({ sessionUpdate: 'agent_message_chunk', messageId: 'msg_4', content: { type: 'text', text: 'blue' } })
        server.promptResponse('end_turn')
      },
    }
    const test = harness({ stored: false, script, answers: [{ id: 'q0', selected: ['blue'], custom: 'teal' }] })
    await expect(test.agent.step(decision(new AbortController().signal))).resolves.toEqual({ kind: 'completed' })

    expect(test.ask).toHaveBeenCalledWith(expect.objectContaining({ wait: { callId: 'call_q' },
      questions: [expect.objectContaining({ id: 'q0', header: 'Color preference', question: 'Which color do you prefer?',
        options: [expect.objectContaining({ label: 'red' }), expect.objectContaining({ label: 'blue' })] })] }))
    // The native `question` call is not projected: the card's synthetic call is the only one with this id.
    const calls = test.events.filter(event => event.type === 'tool/call' && event.data.callId === 'call_q')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.data).toMatchObject({ name: 'ask_user_question' })
    expect(test.events.filter(event => event.type === 'tool/result'
      && (event.data.message as { toolCallId: string }).toolCallId === 'call_q')).toHaveLength(1)
    expect(assistantTexts(test.events)).toEqual([[{ type: 'text', text: 'blue' }]])
    test.detach()
  })
})

describe('native opencode driver session and cancellation', () => {
  it('applies the ticket\'s model and agent before the prompt, model first', async () => {
    const test = harness({ stored: false, model: { provider: 'ds', model: 'deepseek-flash', reasoningEffort: 'high' },
      executor: { opencodeAgent: 'plan' }, script: { prompt: (server) => server.promptResponse('end_turn') } })
    await expect(test.agent.step(decision(new AbortController().signal))).resolves.toEqual({ kind: 'completed' })
    const order = test.server.process.lines.filter(line => typeof line.method === 'string').map(line => line.method)
    const newAt = order.indexOf('session/new'), modelAt = order.indexOf('session/set_config_option'), modeAt = order.indexOf('session/set_mode')
    expect(newAt).toBeGreaterThanOrEqual(0)
    expect(modelAt).toBeGreaterThan(newAt)
    expect(modeAt).toBeGreaterThan(modelAt)
    expect(test.server.process.written('session/set_config_option')[0]!.params).toMatchObject({ configId: 'model', value: 'ds/deepseek-flash#high' })
    expect(test.server.process.written('session/set_mode')[0]!.params).toMatchObject({ modeId: 'plan' })
    test.detach()
  })

  it('spawns the executable configured as the executor\'s opencodeBin before OPENCODE_BIN and the install', async () => {
    const test = harness({ stored: false, executor: { opencodeBin: 'C:/tools/opencode.exe' },
      script: { prompt: server => server.promptResponse('end_turn') } })
    await expect(test.agent.step(decision(new AbortController().signal))).resolves.toEqual({ kind: 'completed' })
    expect(test.commands[0]).toBe('C:/tools/opencode.exe')
    test.detach()
  })

  it('names the available agents when opencode refuses the configured one', async () => {
    const test = harness({ stored: false, executor: { opencodeAgent: 'definitely-not-a-mode' },
      script: { prompt: (server) => server.promptResponse('end_turn') } })
    await expect(test.agent.step(decision(new AbortController().signal)))
      .rejects.toThrow(/has no agent "definitely-not-a-mode".*build, plan/s)
    expect(test.server.prompts).toHaveLength(0)
    test.detach()
  })

  it('discards the frames a session/load replays and keeps the stored session', async () => {
    const script: AcpScript = {
      sessionLoad: () => ({ configOptions: acpConfigOptions() }),
      afterLoad: (server) => {
        // The real agent replays the conversation right after the load response, ending with the command list.
        server.update({ sessionUpdate: 'user_message_chunk', messageId: 'msg_u', content: { type: 'text', text: 'Reply with PONG' } }, 'ses_old')
        server.update({ sessionUpdate: 'agent_message_chunk', messageId: 'msg_a', content: { type: 'text', text: 'PONG' } }, 'ses_old')
        server.update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'init' }] }, 'ses_old')
      },
      prompt: (server) => {
        server.update({ sessionUpdate: 'agent_message_chunk', messageId: 'msg_n', content: { type: 'text', text: 'New answer' } }, 'ses_old')
        server.promptResponse('end_turn')
      },
    }
    const test = harness({ script })
    await expect(test.agent.step(decision(new AbortController().signal))).resolves.toEqual({ kind: 'completed' })
    expect(test.server.process.written('session/load')[0]!.params).toEqual({ sessionId: 'ses_old', cwd: test.directory, mcpServers: [] })
    expect(test.events.filter(event => event.type === 'user/message')).toHaveLength(1)
    expect(assistantTexts(test.events)).toEqual([[{ type: 'text', text: 'New answer' }]])
    // A resumed session already holds the bridge rules: they are not prepended again.
    expect((test.server.prompts[0]!.prompt as { text: string }[])[0]!.text).toBe('Do the work')
    expect(test.store.get(KV.sessions.opencode('worker-t1'))).toMatchObject({ sessionId: 'ses_old' })
    test.detach()
  })

  it('creates a fresh session when the stored one cannot be loaded and resends the turn once', async () => {
    const script: AcpScript = {
      sessionLoad: () => { throw new FakeAcpError(-32602, 'Invalid params: session not found: ses_old') },
      sessionNew: () => ({ sessionId: 'ses_new', configOptions: acpConfigOptions() }),
      prompt: (server) => {
        server.update({ sessionUpdate: 'agent_message_chunk', messageId: 'msg_5', content: { type: 'text', text: 'Restarted' } })
        server.promptResponse('end_turn')
      },
    }
    const test = harness({ script })
    await expect(test.agent.step(decision(new AbortController().signal))).resolves.toEqual({ kind: 'completed' })
    expect(test.server.process.written('session/new')).toHaveLength(1)
    expect(test.events.filter(event => event.type === 'user/message')).toHaveLength(1)
    const prompt = (test.server.prompts[0]!.prompt as { text: string }[])[0]!.text
    expect(prompt.startsWith(BRIDGE_PROMPT)).toBe(true)
    expect(prompt.match(/Do the work/g)).toHaveLength(1)
    expect(test.store.get(KV.sessions.opencode('worker-t1'))).toMatchObject({ sessionId: 'ses_new' })
    test.detach()
  })

  it('cancels the turn, answers the pending card, and rejects with the cancellation', async () => {
    const script: AcpScript = {
      prompt: async (server) => {
        const id = server.request('session/request_permission', { sessionId: 'ses_new',
          toolCall: { toolCallId: 'call_c', name: 'shell', kind: 'execute', status: 'pending', rawInput: { command: 'sleep 10' } },
          options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject' }] })
        // Emulate the agent: the cancel arrives as a notification, then the prompt answers cancelled.
        await waitFor(() => server.process.written('session/cancel').length > 0)
        server.cancelRequest(id)
        server.promptResponse('cancelled')
      },
    }
    const test = harness({ stored: false, script })
    // The question service waits for a person; the turn's abort signal must end it.
    test.ask.mockImplementation(async (request: { signal?: AbortSignal }) => await new Promise((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(new Error('The question was cancelled')), { once: true })
    }))
    const controller = new AbortController()
    const running = test.agent.step(decision(controller.signal))
    await waitFor(() => test.ask.mock.calls.length === 1)
    controller.abort()
    await expect(running).rejects.toThrow(/aborted|cancelled/i)
    expect(test.server.process.written('session/cancel')).toHaveLength(1)
    await waitFor(() => test.server.process.responses.some(message => message.id === 0))
    expect(test.server.process.responses.find(message => message.id === 0)!.result).toEqual({ outcome: { outcome: 'cancelled' } })
    test.detach()
  })

  it('rejects the turn when opencode exits, with its stderr, and spawns again next turn', async () => {
    let prompts = 0
    const script: AcpScript = {
      prompt: (server) => {
        if (prompts++ === 0) {
          server.process.stderr.write('boom: provider unavailable\n')
          server.process.kill(1)
          return
        }
        server.update({ sessionUpdate: 'agent_message_chunk', messageId: 'msg_6', content: { type: 'text', text: 'Second' } })
        server.promptResponse('end_turn')
      },
    }
    const test = harness({ stored: false, script })
    await expect(test.agent.step(decision(new AbortController().signal))).rejects.toThrow(/exited.*boom: provider unavailable/s)
    expect(test.servers).toHaveLength(1)
    await expect(test.agent.step(decision(new AbortController().signal))).resolves.toEqual({ kind: 'completed' })
    expect(test.servers).toHaveLength(2)
    test.detach()
  })

  it('logs child-session updates without projecting them, while its permission still reaches a card', async () => {
    const child = { 'opencode/child-session': { id: 'ses_child', parentID: 'ses_new', depth: 1 } }
    const script: AcpScript = {
      prompt: async (server) => {
        server.update({ sessionUpdate: 'agent_message_chunk', messageId: 'msg_child', content: { type: 'text', text: 'child' }, _meta: child })
        server.update({ sessionUpdate: 'agent_message_chunk', messageId: 'msg_parent', content: { type: 'text', text: 'parent' } })
        const id = server.request('session/request_permission', { sessionId: 'ses_new',
          toolCall: { toolCallId: 'call_child', name: 'read', kind: 'read', status: 'pending', rawInput: { path: 'x' }, _meta: child },
          options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject' }] })
        await server.waitResponse(id)
        server.promptResponse('end_turn')
      },
    }
    const test = harness({ stored: false, script, answers: [{ id: 'permission', selected: ['Allow once'] }] })
    await expect(test.agent.step(decision(new AbortController().signal))).resolves.toEqual({ kind: 'completed' })
    expect(assistantTexts(test.events)).toEqual([[{ type: 'text', text: 'parent' }]])
    expect(test.ask).toHaveBeenCalledTimes(1)
    expect(test.events.filter(event => event.type === 'tool/call' && event.data.callId === 'permission:0')).toHaveLength(1)
    test.detach()
  })
})

it('resolves the resources a ticket card references before prompting opencode', async () => {
  const script: AcpScript = { prompt: (server) => server.promptResponse('end_turn') }
  const test = harness({ stored: false, script })
  const card = JSON.stringify({ ticket_id: 't1', trigger: { trigger_id: 'tr1', preview: 'short', read: 'trigger/tr1' } })
  await expect(test.agent.step(decision(new AbortController().signal, [createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: card }] })]))).resolves.toEqual({ kind: 'completed' })
  const sent = (test.server.prompts[0]!.prompt as { text: string }[])[0]!.text
  expect(sent).toContain('<resource path="trigger/tr1">')
  expect(sent).toContain('FULL TRIGGER TEXT')
  expect(test.execute).toHaveBeenCalledWith(expect.objectContaining({ name: 'orchestrator_read',
    arguments: { resource: 'trigger/tr1', offset: 0, limit: 8000 } }))
  test.detach()
})

// A live ACP turn through the installed opencode. Run with `OPENCODE_SMOKE=1` and `OPENCODE_SMOKE_DIR` naming a directory
// opencode may work in; the paid `ds/deepseek-flash` model is only called when a person opts in. The ordinary suite stays offline.
const smoke = process.env.OPENCODE_SMOKE === '1' ? it : it.skip
describe('native opencode driver against the real ACP process', () => {
  smoke('runs one real turn and records its terminal report', async () => {
    const test = harness({ stored: false, real: process.env.OPENCODE_SMOKE_DIR ?? process.cwd(),
      model: { provider: 'ds', model: 'deepseek-flash' } })
    const prompt = 'Do not use any tools. Reply with exactly "OK" on the first line, then on the second line: '
      + 'DSH_REPORT {"state":"ready","summary":"Smoke test"}'
    await expect(test.agent.step(decision(new AbortController().signal, [createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: prompt }] })]))).resolves.toEqual({ kind: 'completed' })
    const visible = test.events.filter(event => event.type === 'assistant/message')
      .map(event => JSON.stringify(event.data.message)).join('\n')
    expect(visible).toContain('OK')
    expect(visible).not.toContain('DSH_REPORT')
    expect(test.execute).toHaveBeenCalledWith(expect.objectContaining({ name: 'orchestrator_report',
      arguments: expect.objectContaining({ state: 'ready', summary: 'Smoke test' }) }))
    expect(test.store.get(KV.sessions.opencode('worker-t1'))).toMatchObject({ engine: 'opencode' })
    test.detach()
  }, 180_000)
})
