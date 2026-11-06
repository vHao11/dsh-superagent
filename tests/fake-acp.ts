/**
 * A fake native ACP process for the opencode driver tests (W2): a JSON-RPC v1 peer over the same stdio streams a real
 * `opencode.exe acp` child exposes. The driver's spawn seam returns `asChild(fake)`; the test then answers the client's
 * requests and sends server-to-client requests/notifications through `send`, `respond`, `request` and `notify`.
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
  /** Called after each message the driver wrote, so a test can answer it. */
  onLine?: (message: AcpMessage) => void
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
        this.onLine?.(message)
      }
    })
  }
  /** Write one message to the driver over stdout. */
  send(message: AcpMessage): void { this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`) }
  /** Answer the client's request `id` with a result. */
  respond(id: string | number, result: unknown): void { this.send({ id, result }) }
  /** Answer the client's request `id` with an error. */
  fail(id: string | number, code: number, message: string): void { this.send({ id, error: { code, message } }) }
  /** Ask the client a request that expects a response, such as `session/request_permission` or `elicitation/create`. */
  request(id: string | number, method: string, params: unknown): void { this.send({ id, method, params }) }
  /** Send a server-to-client notification, such as `session/update`. */
  notify(method: string, params: unknown): void { this.send({ method, params }) }
  /** End the process, as an exit a driver must settle its active turn on. */
  kill(code = 0): void { this.emit('exit', code, null) }
  /** The messages the driver wrote that name `method`. */
  written(method: string): AcpMessage[] { return this.lines.filter(line => line.method === method) }
}

/** The fake as the `spawn` seam's return type; a test passes it where the driver expects a child process. */
export const asChild = (fake: FakeAcpProcess): ChildProcessWithoutNullStreams =>
  fake as unknown as ChildProcessWithoutNullStreams
