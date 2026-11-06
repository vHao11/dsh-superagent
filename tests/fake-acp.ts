/**
 * A fake native ACP peer for the opencode driver tests (W2): a JSON-RPC v1 server over the same stdio streams a real
 * `opencode.exe acp` child exposes. The driver's spawn seam returns `asChild(fake)`; `FakeAcpServer` answers the handshake
 * and session calls itself and lets a test script drive one prompt's frames.
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

/** One NDJSON JSON-RPC message, as ACP v1 carries it. */
export type AcpMessage = { jsonrpc?: '2.0'; id?: string | number | null; method?: string; params?: unknown; result?: unknown; error?: unknown }

/** A process the driver believes it started: real pass-through streams for stdin, stdout and stderr, and the lines it wrote. */
export class FakeAcpProcess extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = new PassThrough()
  /** Every message the driver wrote, in order, parsed from its NDJSON stdin. */
  readonly lines: AcpMessage[] = []
  /** Every response the driver wrote to a server-to-client request. */
  readonly responses: AcpMessage[] = []
  /** Called after each message the driver wrote, so a test can answer it. */
  onLine?: (message: AcpMessage) => void
  /** Whether the driver closed stdin, which is how opencode is asked to exit. */
  get stdinEnded(): boolean { return this.stdin.writableEnded || this.stdin.destroyed }
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
        const message = JSON.parse(text) as AcpMessage
        this.lines.push(message)
        if (typeof message.method !== 'string') this.responses.push(message)
        this.onLine?.(message)
      }
    })
  }
  /** Write one message to the driver over stdout. */
  send(message: AcpMessage): void { this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`) }
  /** Answer the client's request `id` with a result. */
  respond(id: string | number, result: unknown): void { this.send({ id, result }) }
  /** Answer the client's request `id` with an error. */
  fail(id: string | number, code: number, message: string, data?: unknown): void {
    this.send({ id, error: { code, message, ...(data === undefined ? {} : { data }) } })
  }
  /** Ask the client a request that expects a response, such as `session/request_permission` or `elicitation/create`. */
  request(id: string | number, method: string, params: unknown): void { this.send({ id, method, params }) }
  /** Send a server-to-client notification, such as `session/update`. */
  notify(method: string, params: unknown): void { this.send({ method, params }) }
  /** End the process, as an exit a driver must settle its active turn on. */
  kill(code = 0): void { this.emit('exit', code, null) }
  /** The messages the driver wrote that name `method`. */
  written(method: string): AcpMessage[] {
    return this.lines.filter(line => typeof line.method === 'string' && line.method === method)
  }
}

/** The fake as the `spawn` seam's return type; a test passes it where the driver expects a child process. */
export const asChild = (fake: FakeAcpProcess): ChildProcessWithoutNullStreams =>
  fake as unknown as ChildProcessWithoutNullStreams

/** How a `session/load` script fails a load: `FakeAcpServer` answers with this JSON-RPC error. */
export class FakeAcpError extends Error {
  constructor(readonly code: number, message: string) { super(message) }
}

/** One config option list as `session/new` returns it, with the model and mode a test needs. */
export function acpConfigOptions(model = 'opencode/crouton-alpha-free', mode = 'build'): unknown[] {
  return [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model,
      options: [{ value: model, name: model }, { value: 'opencode/crouton-alpha-free', name: 'Crouton Alpha Free' }] },
    { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'default',
      options: [{ value: 'low', name: 'Low' }, { value: 'default', name: 'Default' }] },
    { id: 'mode', name: 'Session Mode', category: 'mode', type: 'select', currentValue: mode,
      options: [{ value: 'build', name: 'Build' }, { value: 'plan', name: 'Plan' }] },
  ]
}

/** The `initialize` result of the probed opencode 2.2.5, which the fake answers unless a script overrides it. */
export const ACP_INITIALIZE = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    mcpCapabilities: { http: true, sse: false },
    promptCapabilities: { embeddedContext: true, image: true },
    sessionCapabilities: { additionalDirectories: {}, close: {}, delete: {}, fork: {}, list: {}, resume: {} },
    _meta: { 'opencode/child-session-updates': true },
  },
  authMethods: [{ description: 'Run `opencode auth login` in the terminal', name: 'Login with opencode', id: 'opencode-login' }],
  agentInfo: { name: 'OpenCode', version: '2.2.5' },
}

/** Scripted behavior of one fake ACP server; the defaults answer a clean handshake and an empty turn. */
export interface AcpScript {
  /** The `initialize` result; defaults to {@link ACP_INITIALIZE}. */
  initialize?: unknown
  /** The `session/new` result; defaults to a fresh session with {@link acpConfigOptions}. */
  sessionNew?: (params: Record<string, unknown>) => unknown
  /** The `session/load` result; throw {@link FakeAcpError} to fail the load. Defaults to the config options only. */
  sessionLoad?: (params: Record<string, unknown>) => unknown
  /** The `session/set_config_option` result; defaults to config options carrying the requested model. */
  setConfig?: (params: Record<string, unknown>) => unknown
  /** Runs after the `session/new` response, so a script can send the command list the real agent follows it with. */
  afterNew?: (server: FakeAcpServer) => void
  /** Runs after the `session/load` response: this is where history replay frames belong. */
  afterLoad?: (server: FakeAcpServer) => void
  /** Runs when `session/prompt` arrives. The script sends updates and finally calls `server.promptResponse`. */
  prompt?: (server: FakeAcpServer, params: Record<string, unknown>, index: number) => void | Promise<void>
}

/** Whether `value` is a plain JSON object. */
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Wait until `condition` holds, yielding to the event loop; fails when it never does. */
export async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error('The fake ACP peer never reached the expected step')
}

/**
 * A scripted ACP server for one fake process: answers initialize and the session calls with their probed shapes, records the
 * driver's prompts, and exposes helpers a prompt script (or a test) uses to send updates and server-to-client requests.
 */
export class FakeAcpServer {
  readonly process = new FakeAcpProcess()
  /** Every `session/prompt` params object, in order. */
  readonly prompts: Record<string, unknown>[] = []
  private promptId?: string | number
  private serverId = 0
  constructor(private readonly script: AcpScript = {}) {
    this.process.onLine = message => { void this.handle(message) }
  }
  /** The fake child process to hand the driver's spawn seam. */
  get child(): FakeAcpProcess { return this.process }
  private async handle(message: AcpMessage): Promise<void> {
    // A response to one of this server's own requests is a test's to inspect.
    if (typeof message.method !== 'string' || message.id === undefined || message.id === null) return
    const id = message.id
    const params = isRecord(message.params) ? message.params : {}
    switch (message.method) {
      case 'initialize': return this.answer(id, this.script.initialize ?? ACP_INITIALIZE)
      case 'session/new': {
        this.answer(id, this.script.sessionNew?.(params) ?? { sessionId: 'ses_new', configOptions: acpConfigOptions() })
        this.script.afterNew?.(this)
        return
      }
      case 'session/load': {
        try {
          this.answer(id, this.script.sessionLoad?.(params) ?? { configOptions: acpConfigOptions() })
        } catch (error) {
          const failure = error instanceof FakeAcpError ? error : new FakeAcpError(-32603, String(error))
          this.process.fail(id, failure.code, failure.message)
          return
        }
        this.script.afterLoad?.(this)
        return
      }
      case 'session/set_config_option': {
        const result = this.script.setConfig?.(params)
          ?? { configOptions: acpConfigOptions(typeof params.value === 'string' ? params.value : 'ds/deepseek-flash') }
        return this.answer(id, result)
      }
      case 'session/set_mode': {
        // The real agent rejects an unknown mode with this exact shape; mirror it so the driver's error path is testable.
        if (params.modeId === 'definitely-not-a-mode') {
          return this.process.fail(id, -32602, `Invalid params: mode not found: ${String(params.modeId)}`, { mode: params.modeId })
        }
        return this.answer(id, {})
      }
      case 'session/prompt': {
        this.prompts.push(params)
        this.promptId = id
        await this.script.prompt?.(this, params, this.prompts.length - 1)
        return
      }
      case 'session/close':
      case 'session/delete': return this.answer(id, {})
      default: return this.process.fail(id, -32601, `"Method not found": ${message.method}`, { method: message.method })
    }
  }
  private answer(id: string | number, result: unknown): void { this.process.respond(id, result) }
  /** Send one `session/update` notification for this session. */
  update(update: Record<string, unknown>, sessionId = 'ses_new'): void {
    this.process.notify('session/update', { sessionId, update })
  }
  /** Answer the current prompt with its ACP result. */
  promptResponse(stopReason = 'end_turn', usage?: unknown): void {
    const id = this.promptId
    if (id === undefined) throw new Error('No prompt is running')
    this.promptId = undefined
    this.process.respond(id, { stopReason, ...(usage === undefined ? {} : { usage }), _meta: {} })
  }
  /** Ask the driver a server-to-client request; returns its JSON-RPC id. */
  request(method: string, params: unknown): number {
    const id = this.serverId++
    this.process.request(id, method, params)
    return id
  }
  /** Send the agent's `$/cancel_request` for one pending server request. */
  cancelRequest(id: number): void { this.process.notify('$/cancel_request', { requestId: id }) }
  /** Wait for the driver's response to server request `id`. */
  async waitResponse(id: number, timeoutMs = 2000): Promise<AcpMessage> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = this.process.responses.find(message => message.id === id)
      if (found) return found
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    throw new Error(`The driver did not answer the server request ${id}`)
  }
}
