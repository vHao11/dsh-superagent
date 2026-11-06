/**
 * Native opencode worker bridge: one persistent `opencode acp` process per DSH worker Session, its ACP v1 (stdio NDJSON
 * JSON-RPC) events projected into the Session log, and its permission and elicitation requests routed to DSH's approval and
 * question cards.
 *
 * The driver replaces only `ReactLoopAgent.step(decision)`. DSH still owns the turn/step boundaries, the inbox, Session
 * persistence, root registration, status, and the executor's idle/report handling. The ACP behavior follows the 2026-11-06
 * wire probe (`workenvfix/.scratch/opencode-acp-probe-20261106/REPORT.md`): `agent_thought_chunk` carries thinking, tool
 * names are authoritative (kind is only a risk hint), `session/load` replays history that must be discarded, and a person's
 * rejection ends the whole prompt turn with `stopReason: "cancelled"`.
 */
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId, createAssistantMessage, createToolResultMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { EpochHeader, SessionSeq } from '@deepseek-ai/dsh-session'
import type { EngineName, OpencodeApproval, Ticket } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { Settings } from '../policy.ts'
import type { RoleModel } from '../policy.ts'
import type { Store } from '../app/store.ts'
import {
  ASK_TOOL, ASK_TOOL_SCHEMA, BRIDGE_PROMPT, CardResources, INTERRUPT_WAIT_MS, abortError, asString, delay, isRecord, jsonArguments,
  mapToolName, permissionQuestion, recordWorkerReport, stripWorkerReport, textContent, toToolQuestion, toolResultContent,
  type DshAnswer, type DshQuestion, type StepDecision, type StepEnd, type SteppableAgent, type UserQuestionsService,
  type WorkerReport,
} from './native-shared.ts'

/** A guide appended to a spawn or model failure: the two things an opencode engine needs from its machine. */
const SETUP_HINT = 'Install opencode 2.2+ (npm install -g @opencode/cli) or set OPENCODE_BIN to its opencode.exe, '
  + 'and make its providers usable (`opencode auth login`, `opencode models`).'
/** How long a session control request (initialize, load, new, config) may take before the process is treated as hung. */
const CONTROL_TIMEOUT_MS = 30_000
/** How long a load waits for its replay to end (the trailing `available_commands_update`) before the turn starts. */
const REPLAY_WAIT_MS = 300
/** One ACP prompt content block; the bridge sends text only. */
interface AcpTextBlock { type: 'text'; text: string }
/** The `configOptions` ACP returns from `session/new`, `session/load` and `session/set_config_option`. */
interface AcpConfigOption { id?: string; currentValue?: unknown; options?: unknown }
/** The result of one `session/prompt` request. */
interface PromptResult { stopReason?: string; usage?: unknown }
/** One active opencode prompt turn, settled by its prompt response, process exit, or cancellation. */
interface ActiveTurn {
  turn: number
  step: number
  signal: AbortSignal
  promise: Promise<PromptResult>
  resolve: (result: PromptResult) => void
  reject: (error: Error) => void
  /** Resolves when the agent answered the cancellation with its prompt response, or the process ended. */
  stopped: Promise<void>
  stop: () => void
  cleanup: () => void
}
/** One client-to-agent request awaiting its JSON-RPC response. */
interface PendingRequest { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void }
/** One agent-to-client request awaiting the bridge's answer (a permission or question card). */
interface PendingServerRequest { method: string; controller: AbortController }
/** The merged state of one opencode tool call across its `tool_call` and `tool_call_update` notifications. */
interface ToolState {
  id: string
  name?: string
  kind?: string
  title?: string
  rawInput?: unknown
  status?: string
  locations?: unknown
  content?: unknown
  rawOutput?: unknown
}
/** One JSON-RPC error opencode answered with; `code` and `data` let the driver explain provider and mode problems. */
class AcpError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message) }
}
/** Options used to attach the opencode ACP driver to one DSH worker agent. */
export interface OpencodeOptions {
  readonly context: Context
  readonly agent: Agent
  readonly ticket: Ticket
  readonly store: Pick<Store, 'get' | 'set'>
  readonly settings: () => Settings['executor']
  /** The model and reasoning effort this worker runs with, from the Ticket's snapshot; null keeps opencode's own configuration. */
  readonly model?: () => RoleModel | null
  /** The ticket's worker instructions (the same text a DSH worker's system prompt carries), sent at the head of the first prompt. */
  readonly instructions?: () => string
  readonly logger: Context['logger']
  readonly lifetime: AbortSignal
  /** The execution variables of the ticket, passed to the native process as `DSH_SUPERAGENT_*` environment. */
  readonly environment?: () => { key: string; value: string }[]
  /** Test seam: defaults to `node:child_process.spawn`. */
  readonly spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcessWithoutNullStreams
}

/** opencode tool names mapped to the names the DSH panel renders; unknown tools keep opencode's name. */
const TOOL_NAMES: Readonly<Record<string, string>> = {
  read: 'read', shell: 'bash', bash: 'bash', pwsh: 'pwsh', write: 'write', edit: 'edit', patch: 'edit', glob: 'glob', grep: 'grep',
  webfetch: 'web_fetch', websearch: 'web_search', task: 'subagent', subagent: 'subagent', skill: 'skill', question: ASK_TOOL,
}
/** The tools the smart approval settles without a person: reads, searches, web lookups and skills. */
const AUTO_ONCE = new Set(['read', 'list', 'glob', 'grep', 'websearch', 'webfetch', 'web_fetch', 'web_search', 'skill', 'todo_write', 'todoread'])

/** Map an opencode tool name to the DSH name the panel renders. */
export function opencodeToolName(name: string): string {
  return mapToolName(name, TOOL_NAMES)
}

/**
 * How the bridge answers one opencode permission request. `approve` and `deny` keep an unattended Ticket from waiting;
 * `ask` always asks; `smart` settles reads and searches itself and asks a person for writes, executions and the unknown.
 */
export type PermissionChoice = 'once' | 'reject' | 'ask'
export function permissionChoice(tool: { name?: string; kind?: string }, approval: OpencodeApproval): PermissionChoice {
  if (approval === 'approve') return 'once'
  if (approval === 'deny') return 'reject'
  if (approval === 'ask') return 'ask'
  const name = tool.name ?? ''
  if (AUTO_ONCE.has(name)) return 'once'
  // Only a missing name may fall back to the ACP kind; a named tool the bridge does not know stays a person's decision.
  if (!name && (tool.kind === 'read' || tool.kind === 'search')) return 'once'
  return 'ask'
}

/** One option of an elicitation field: the label DSH's card shows and the JSON-schema value opencode expects back. */
export interface ElicitationOption { label: string; value: string; description?: string }
/** One answered field of an `elicitation/create` form. */
export interface ElicitationField { key: string; multiSelect: boolean; options: ElicitationOption[]; customKey?: string }
/** The DSH questions one `elicitation/create` form maps to, and the fields their answers map back through. */
export interface ElicitationQuestions { questions: DshQuestion[]; fields: ElicitationField[] }

/**
 * Convert an ACP `elicitation/create` form schema into DSH questions. Each property is one question: its `title` is the
 * header, its `description` the question text (opencode puts the real question there), and its `oneOf` entries the options.
 * A `<key>_custom` property allows the person's own answer and is not a question of its own.
 */
export function questionsFromElicitation(params: unknown): ElicitationQuestions {
  const request = isRecord(params) ? params : {}
  const schema = isRecord(request.requestedSchema) ? request.requestedSchema : {}
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const questions: DshQuestion[] = []
  const fields: ElicitationField[] = []
  for (const [key, value] of Object.entries(properties)) {
    if (!isRecord(value) || key.endsWith('_custom')) continue
    if (value.type !== 'string' && value.type !== 'array') continue
    const choices = Array.isArray(value.oneOf) ? value.oneOf : Array.isArray(value.enum) ? value.enum : []
    const options = choices.flatMap((choice): ElicitationOption[] => {
      if (isRecord(choice)) {
        const fallback = typeof choice.const === 'string' ? choice.const : typeof choice.const === 'number' ? String(choice.const) : undefined
        const label = asString(choice.title) ?? fallback
        if (!label) return []
        return [{ label, value: fallback ?? label, ...(asString(choice.description) ? { description: choice.description as string } : {}) }]
      }
      if (typeof choice === 'string') return [{ label: choice, value: choice }]
      return []
    })
    const header = asString(value.title)
    const multiSelect = value.type === 'array'
    questions.push({
      id: key,
      question: asString(value.description) ?? header ?? key,
      ...(header ? { header } : {}),
      ...(options.length ? { options: options.map(option => ({ label: option.label, ...(option.description ? { description: option.description } : {}) })) } : {}),
      ...(multiSelect ? { multiSelect: true } : {}),
    })
    fields.push({ key, multiSelect, options, ...(isRecord(properties[`${key}_custom`]) ? { customKey: `${key}_custom` } : {}) })
  }
  return { questions, fields }
}

/**
 * Map DSH answers back to an `elicitation/create` success content object. A custom answer rides in `<key>_custom`; when it is
 * the only answer, the field also carries a valid option value so opencode does not reject an empty selection. An answer set
 * with no selection at all declines the form, which opencode treats as dismissing the question.
 */
export function elicitationAnswers(fields: readonly ElicitationField[], answers: readonly DshAnswer[]):
{ action: 'accept'; content: Record<string, unknown> } | { action: 'decline' } {
  const byId = new Map(answers.map(answer => [answer.id, answer]))
  const content: Record<string, unknown> = {}
  for (const field of fields) {
    const answer = byId.get(field.key)
    const selected = answer?.selected ?? []
    const custom = answer?.custom?.trim()
    const values = selected.map(label => field.options.find(option => option.label === label)?.value ?? label).filter(value => value !== '')
    if (values.length) {
      content[field.key] = field.multiSelect ? values : values[0]
      if (custom && field.customKey) content[field.customKey] = custom
      continue
    }
    const first = field.options[0]?.value
    if (custom && field.customKey && first !== undefined) {
      content[field.key] = field.multiSelect ? [first] : first
      content[field.customKey] = custom
    }
  }
  return Object.keys(content).length ? { action: 'accept', content } : { action: 'decline' }
}

/** What one prompt response means for the DSH step. */
export type StopReasonOutcome = { end: StepEnd } | { abort: true } | { failure: string }
/**
 * Map an ACP `stopReason` to the DSH step's ending. A `cancelled` turn is an abort when the DSH signal caused it; otherwise a
 * person rejected a permission or dismissed a question, which ends the turn without failing the ticket (the executor reports
 * the worker waiting, and the person or a later input decides what happens next).
 */
export function stopReasonOutcome(stopReason: unknown, aborted: boolean): StopReasonOutcome {
  switch (typeof stopReason === 'string' ? stopReason : '') {
    case 'end_turn': return { end: { kind: 'completed' } }
    case 'max_tokens':
    case 'max_turn_requests': return { end: { kind: 'max-tokens' } }
    case 'cancelled': return aborted ? { abort: true } : { end: { kind: 'completed' } }
    case 'refusal': return { failure: 'opencode refused to continue the turn (stopReason: refusal)' }
    default:
      return { failure: `opencode ended the turn with ${stopReason === undefined ? 'no stopReason' : `stopReason "${String(stopReason)}"`}` }
  }
}

/** Build one assistant message from the text and thinking chunks buffered for it, stripping a worker report line. */
export function assistantContent(reasoning: string, text: string): { content: ContentBlock[]; report?: WorkerReport } {
  const visible = stripWorkerReport(text)
  const content: ContentBlock[] = []
  // The probe always sent thinking before the visible answer; the card renders reasoning as the same message's first block.
  if (reasoning.trim()) content.push({ type: 'reasoning', text: reasoning })
  if (visible.text) content.push({ type: 'text', text: visible.text })
  return { content, ...(visible.report ? { report: visible.report } : {}) }
}

/** Render a file diff an ACP tool result may carry, as text DSH's tool result can hold. */
function diffText(diff: Record<string, unknown>): string {
  const path = asString(diff.path) ?? 'file'
  const oldText = typeof diff.oldText === 'string' ? diff.oldText : ''
  const newText = typeof diff.newText === 'string' ? diff.newText : ''
  const body = `--- ${path}\n${oldText}\n+++ ${path}\n${newText}`
  return body.length > 4000 ? `${body.slice(0, 4000)}…` : body
}

/** Convert one finished opencode tool call into DSH tool-result content and its error state. */
export function toolResultFromUpdate(update: Record<string, unknown>): { content: ContentBlock[]; isError: boolean } {
  const content: ContentBlock[] = []
  if (Array.isArray(update.content)) {
    for (const item of update.content) {
      if (!isRecord(item)) continue
      if (item.type === 'content') {
        // ACP wraps each result part as `{type:"content", content:<part>}`; a part is text, a diff, or a JSON block.
        const inner = item.content
        if (isRecord(inner) && inner.type === 'diff') content.push({ type: 'text', text: diffText(inner) })
        else if (isRecord(inner) && inner.type === 'text' && typeof inner.text === 'string') content.push({ type: 'text', text: inner.text })
        else content.push(...toolResultContent(inner))
      } else if (item.type === 'diff') content.push({ type: 'text', text: diffText(item) })
      else content.push(...toolResultContent(item))
    }
  }
  const output = isRecord(update.rawOutput) ? update.rawOutput : {}
  const error = asString(output.error)
  if (error) content.push({ type: 'text', text: error })
  return { content: content.length ? content : [{ type: 'text', text: '' }], isError: update.status === 'failed' }
}

/** Whether a `session/update` belongs to a subagent's child session, which the bridge logs but does not project. */
export function isChildUpdate(update: Record<string, unknown>): boolean {
  const meta = isRecord(update._meta) ? update._meta : {}
  return isRecord(meta['opencode/child-session'])
}

/** Resolve `path` for comparison, leaving an unresolvable path as it is. */
const normalizePath = (path: string): string => { try { return resolve(path) } catch { return path } }
/** Whether two directories name the same place on this platform. */
export function sameCwd(left: string, right: string): boolean {
  const a = normalizePath(left), b = normalizePath(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * Resolve the opencode executable: the executor's `opencodeBin` setting, `OPENCODE_BIN`, the Windows npm global install,
 * then PATH. It never returns the `.cmd` wrapper: that needs a shell and widens the injection surface.
 * @param configured - The executor's `opencodeBin` setting; empty falls back to the environment and the install.
 * @returns A path or command name for `spawn`.
 */
export function resolveOpencodeBin(configured = ''): string {
  const explicit = configured.trim() || process.env.OPENCODE_BIN?.trim()
  if (explicit) return explicit
  if (process.platform === 'win32') {
    const suffixes = [join('npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe')]
    const roots = [process.env.APPDATA?.trim(), join(homedir(), 'AppData', 'Roaming')].filter((root): root is string => !!root)
    for (const root of roots) {
      for (const suffix of suffixes) {
        const candidate = join(root, suffix)
        if (existsSync(candidate)) return candidate
      }
    }
    return 'opencode.exe'
  }
  return 'opencode'
}

/** The `configOptions` of a session response, or an empty list when the agent sent none. */
function configOptionsOf(value: unknown): AcpConfigOption[] {
  if (!isRecord(value) || !Array.isArray(value.configOptions)) return []
  return value.configOptions.filter(isRecord) as AcpConfigOption[]
}

/** The current value of one config option, when it is a string. */
function currentValueOf(options: readonly AcpConfigOption[], id: string): string | undefined {
  const option = options.find(item => item.id === id)
  return typeof option?.currentValue === 'string' ? option.currentValue : undefined
}

/** The option values one config option offers, for an actionable error when a configured value is missing. */
function optionValuesOf(options: readonly AcpConfigOption[], id: string): string[] {
  const option = options.find(item => item.id === id)
  if (!Array.isArray(option?.options)) return []
  return option.options.flatMap(item => isRecord(item) && typeof item.value === 'string' ? [item.value] : [])
}

/** Combine one ACP cancellation signal with the turn's and the driver's lifetime. */
function combineSignals(signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (!present.length) return undefined
  return present.length === 1 ? present[0] : AbortSignal.any(present)
}

/**
 * One persistent native opencode ACP process attached to a DSH worker Session. It replaces the agent's model step, maps
 * `session/update` notifications to Session events, and bridges permission and elicitation requests to DSH's
 * `userQuestions` service so the Web UI shows the same cards as other workers.
 */
export class OpencodeDriver {
  private readonly context: Context
  private readonly agent: Agent
  private readonly session: Agent['session']
  private readonly ticket: Ticket
  private readonly store: Pick<Store, 'get' | 'set'>
  private readonly settings: () => Settings['executor']
  private readonly configuredModel: () => RoleModel | null
  private readonly workerInstructions?: () => string
  private readonly logger: Context['logger']
  private readonly environment?: () => { key: string; value: string }[]
  private readonly spawnProcess: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcessWithoutNullStreams
  private readonly resources: CardResources
  private child?: ChildProcessWithoutNullStreams
  private reader?: Interface
  private processAbort?: AbortController
  private active?: ActiveTurn
  private readonly lifetimeListener: () => void
  private disposed = false
  private headerLogged = false
  private nextId = 0
  /** Client-to-agent requests awaiting their response, by JSON-RPC id. */
  private readonly pending = new Map<number, PendingRequest>()
  /** Agent-to-client requests awaiting a card answer, by JSON-RPC id. */
  private readonly serverPending = new Map<number | string, PendingServerRequest>()
  /** Whether this process finished `initialize` and its ACP session is configured. */
  private ready = false
  private sessionId?: string
  private config: AcpConfigOption[] = []
  private model = 'opencode'
  /** Whether the current process is replaying a loaded session's history, which must not be projected again. */
  private replaying = false
  private replayDone?: () => void
  private replayTimer?: ReturnType<typeof setTimeout>
  /** Whether the current process tried `session/load` and has not yet loaded a session. */
  private loading = false
  /** A load failed before the session was ready: the step retries once in a fresh session, like Claude's resume. */
  private resumeFailed = false
  /** Whether the bridge rules were already sent to the current ACP session. */
  private bridgeSent = false
  private lastTurn = 1
  private lastStep = 1
  private reportSeq = 0
  private pendingReport?: WorkerReport
  private reportedTerminal = false
  /** Tool-call log seqs that still await a result, by opencode `toolCallId`. */
  private readonly callSeq = new Map<string, SessionSeq>()
  /** Every opencode `toolCallId` whose `tool/call` was already logged, including bridged question cards. */
  private readonly appendedCalls = new Set<string>()
  /** Tool-call ids whose result the bridge already logged as a card, so the engine's own result must not duplicate it. */
  private readonly syntheticResults = new Set<string>()
  /** The state of every open tool call of the current turn, merged across its notifications. */
  private readonly toolStates = new Map<string, ToolState>()
  /** The assistant message text and thinking chunks of the current message id, not yet appended. */
  private message?: { id: string; reasoning: string; text: string }
  private queue: Promise<void> = Promise.resolve()
  private stderrTail: string[] = []

  constructor(options: OpencodeOptions) {
    this.context = options.context
    this.agent = options.agent
    this.session = options.agent.session
    this.ticket = options.ticket
    this.store = options.store
    this.settings = options.settings
    this.configuredModel = options.model ?? (() => null)
    this.workerInstructions = options.instructions
    this.logger = options.logger
    this.environment = options.environment
    this.resources = new CardResources(options.agent, options.logger, 'opencode', 'opencode-read')
    this.spawnProcess = options.spawn ?? ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions) as ChildProcessWithoutNullStreams)
    const onAbort = () => this.dispose()
    this.lifetimeListener = () => options.lifetime.removeEventListener('abort', onAbort)
    if (options.lifetime.aborted) queueMicrotask(onAbort)
    else options.lifetime.addEventListener('abort', onAbort, { once: true })
  }

  /** Replace the loop's model step with this driver's native opencode turn. */
  attach(): () => void {
    const loop = this.agent as unknown as SteppableAgent
    const original = loop.step
    loop.step = decision => this.step(decision)
    return () => {
      loop.step = original
      this.dispose()
    }
  }

  /** Run one DSH step through opencode: append the claimed messages, send them as one prompt, and wait for the turn result. */
  async step(decision: StepDecision): Promise<StepEnd | null> {
    if (this.disposed) throw new Error('The native opencode worker is disposed')
    const turn = decision.turn ?? this.lastTurn
    const step = decision.step ?? this.lastStep
    const signal = decision.signal ?? (this.agent as unknown as { phase?: { abort?: AbortController } }).phase?.abort?.signal
    if (!signal) throw new Error('The native opencode worker needs the turn cancellation signal')
    signal.throwIfAborted()
    this.lastTurn = turn
    this.lastStep = step
    this.reportedTerminal = false
    this.pendingReport = undefined
    let retried = false
    let appended = false
    for (;;) {
      const messages = decision.messages.filter(message => (message.source as { kind?: string }).kind !== 'runtime-context')
      if (!messages.length) return { kind: 'completed' }
      try {
        // A process may have exited after the previous turn; the spawn and session setup happen inside the try so a
        // session that could not be loaded retries once in a fresh native session.
        await this.ensureProcess()
        await this.ensureSession(signal)
        this.logHeader()
        // DSH's loop normally records the claimed messages; a replaced step does it, exactly once per DSH message.
        if (!appended) {
          for (const message of messages) this.session.append('user/message', message, { surfaceOp: 'append' })
          appended = true
        }
        const prompt: AcpTextBlock[] = []
        for (const message of messages) {
          for (const block of textContent(message, 'the native opencode process cannot read this attachment')) {
            prompt.push({ type: 'text', text: await this.resources.expand(block.text, signal) })
          }
        }
        if (!prompt.length) return { kind: 'completed' }
        // opencode has no `--append-system-prompt`: the bridge rules and the worker instructions ride at the head of a
        // fresh session's first prompt, where they stay in that session's context for every later turn. The instructions
        // are the same policy, mandate and task-type text a DSH worker reads in its system prompt.
        const first = prompt[0]
        if (first && !this.bridgeSent) {
          const instructions = this.workerInstructions?.() ?? ''
          first.text = [BRIDGE_PROMPT, instructions, first.text].filter(Boolean).join('\n\n')
          this.bridgeSent = true
        }
        const result = await this.runTurn(turn, step, signal, prompt)
        await this.flushReport(signal)
        const outcome = stopReasonOutcome(result.stopReason, signal.aborted)
        if ('failure' in outcome) {
          // A terminal worker report already gave the executor the outcome; do not fail the ticket a second time.
          if (this.reportedTerminal) return { kind: 'completed' }
          throw new Error(outcome.failure)
        }
        if ('abort' in outcome) throw abortError(signal, 'The opencode turn was cancelled')
        return outcome.end
      } catch (error) {
        if (!retried && this.resumeFailed && !signal.aborted) {
          retried = true
          this.resumeFailed = false
          this.forgetSession()
          this.resetProcess()
          continue
        }
        throw this.explain(error)
      }
    }
  }

  /** Spawn the persistent opencode ACP process, start its stdout queue, and complete the ACP handshake. */
  private async ensureProcess(): Promise<void> {
    if (this.child) return
    if (this.disposed) throw new Error('The native opencode worker is disposed')
    const settings = this.readSettings()
    const bin = resolveOpencodeBin(settings.opencodeBin)
    const cwd = this.ticket.execution?.directory ?? process.cwd()
    const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: '1' }
    try {
      for (const variable of this.environment?.() ?? []) {
        if (/^DSH_SUPERAGENT_[A-Z0-9_]+$/.test(variable.key)) env[variable.key] = variable.value
      }
    } catch (error) {
      this.logger.debug('dsh-superagent could not read the execution variables for %s: %s', this.agent.id, String(error))
    }
    let child: ChildProcessWithoutNullStreams
    try {
      child = this.spawnProcess(bin, ['acp'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      throw new Error(`Cannot start the native opencode process (${bin}): ${error instanceof Error ? error.message : String(error)}. ${SETUP_HINT}`)
    }
    this.child = child
    this.processAbort = new AbortController()
    this.stderrTail = []
    this.ready = false
    this.resumeFailed = false
    this.loading = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    this.reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.reader.on('line', line => {
      // A replaced process's remaining lines must not land in the next process's active turn.
      this.queue = this.queue.then(() => this.child === child ? this.handleLine(line) : undefined).catch(error => {
        this.logger.warn('dsh-superagent could not handle an opencode frame for %s: %s', this.agent.id, String(error))
      })
    })
    child.stderr.on('data', (chunk: string | Buffer) => this.rememberStderr(String(chunk)))
    child.stdin.on('error', (error: Error) => this.logger.debug('dsh-superagent opencode stdin for %s: %s', this.agent.id, error.message))
    child.on('error', (error: Error) => this.processFailed(error))
    child.on('exit', (code, exitSignal) => this.processExited(code, exitSignal))
    try {
      await this.initialize()
    } catch (error) {
      this.resetProcess()
      throw this.explain(error)
    }
  }

  /** Complete the ACP handshake with the capabilities this bridge actually implements. */
  private async initialize(): Promise<void> {
    const result = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        // opencode keeps its own file and terminal tools: it must not ask this bridge to serve fs/* or terminal/*.
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        // ACP requires an object to advertise form elicitation; `true` makes opencode's question tool unable to show a form.
        elicitation: { form: {} },
        session: { compaction: true },
        _meta: { 'opencode/child-session-updates': true },
      },
      clientInfo: { name: 'dsh-superagent', version: process.env.npm_package_version ?? '0.0.0' },
    }, undefined, CONTROL_TIMEOUT_MS)
    const record = isRecord(result) ? result : {}
    if (record.protocolVersion !== 1) {
      throw new Error(`opencode answered ACP version ${String(record.protocolVersion)}, but this bridge needs ACP v1. Update opencode (npm install -g @opencode/cli)`)
    }
    const info = isRecord(record.agentInfo) ? record.agentInfo : {}
    const version = asString(info.version) ?? 'unknown'
    const major = Number.parseInt(version.split('.')[0] ?? '', 10)
    if (Number.isFinite(major) && major < 2) {
      throw new Error(`opencode ${version} is too old for the DSH opencode engine: the ACP permission and question flow needs opencode 2.2+. Update it (npm install -g @opencode/cli)`)
    }
    this.logger.info('dsh-superagent native opencode worker %s initialized (opencode %s)', this.agent.id, version)
  }

  /** Log the native tool declaration DSH's question projection reads, once per DSH Session. */
  private logHeader(): void {
    if (this.headerLogged) return
    this.headerLogged = true
    const header: EpochHeader = { config: { provider: 'opencode', model: this.model }, tools: [ASK_TOOL_SCHEMA] }
    const existing = this.session.requestHeader()
    this.session.append('request/header', { header, reason: existing ? 'change' : 'initial', ...(existing ? { startsSeries: true } : {}) })
  }

  /** Resume the stored ACP session when it belongs to this cwd, else create one; then apply the Ticket's model and agent. */
  private async ensureSession(signal: AbortSignal): Promise<void> {
    if (this.ready) return
    if (!this.child) throw new Error('The native opencode process is not running')
    const cwd = this.ticket.execution?.directory ?? process.cwd()
    let stored: { sessionId?: string; cwd?: string } | undefined
    try { stored = this.store.get(KV.sessions.opencode(this.agent.id)) } catch (error) {
      this.logger.debug('dsh-superagent could not read the opencode session of %s: %s', this.agent.id, String(error))
    }
    const storedId = stored?.sessionId
    let resumeId = storedId
    if (storedId && stored?.cwd && !sameCwd(stored.cwd, cwd)) {
      // ACP requires the same cwd; a session created elsewhere cannot be loaded here.
      this.logger.info('dsh-superagent will not resume the opencode session %s of %s: it belongs to %s, not %s',
        storedId, this.agent.id, stored.cwd, cwd)
      this.forgetSession()
      resumeId = undefined
    }
    if (resumeId) {
      this.sessionId = resumeId
      this.loading = true
      this.replaying = true
      try {
        const result = await this.request('session/load', { sessionId: resumeId, cwd, mcpServers: [] }, signal, CONTROL_TIMEOUT_MS)
        this.loading = false
        this.config = configOptionsOf(result)
        this.updateModel()
        // The load replays the conversation's history next; it must not be projected into the DSH Session a second time.
        await this.awaitReplayEnd()
        this.bridgeSent = true
        this.logger.info('dsh-superagent resumed the opencode session %s of %s', resumeId, this.agent.id)
      } catch (error) {
        this.loading = false
        this.resumeFailed = true
        this.finishReplay()
        this.logger.warn('dsh-superagent could not load the opencode session %s of %s; starting a new one: %s',
          resumeId, this.agent.id, String(error))
        this.forgetSession()
        if (!this.child) throw error
        await this.newSession(cwd, signal)
        this.resumeFailed = false
      }
    } else {
      await this.newSession(cwd, signal)
    }
    if (!this.sessionId) throw new Error('opencode created no session for this worker')
    await this.applyConfig(signal)
    this.ready = true
  }

  /** Create one ACP session in the ticket's directory and persist its id for a later resume. */
  private async newSession(cwd: string, signal: AbortSignal): Promise<void> {
    const result = await this.request('session/new', { cwd, mcpServers: [] }, signal, CONTROL_TIMEOUT_MS)
    const record = isRecord(result) ? result : {}
    const sessionId = asString(record.sessionId)
    if (!sessionId) throw new Error('opencode created a session without a sessionId')
    this.sessionId = sessionId
    this.config = configOptionsOf(result)
    this.updateModel()
    this.bridgeSent = false
    this.rememberSession()
  }

  /** Apply the Ticket's snapshotted opencode parameters: the shared execution model first, then the agent (mode) that uses it. */
  private async applyConfig(signal: AbortSignal): Promise<void> {
    const settings = this.readSettings()
    // opencode names a model `provider/model`, with `#variant` for a reasoning variant; the shared model carries both parts.
    const configured = this.modelName()
    if (configured && currentValueOf(this.config, 'model') !== configured) {
      try {
        const result = await this.request('session/set_config_option', { sessionId: this.sessionId, configId: 'model', value: configured },
          signal, CONTROL_TIMEOUT_MS)
        const options = configOptionsOf(result)
        if (options.length) this.config = options
        else this.setCurrent('model', configured)
        this.updateModel()
      } catch (error) {
        throw new Error(`opencode could not use the model "${configured}": ${this.describe(error)}. `
          + 'Choose a model this machine can use in the task type\'s model picker (the same provider/model opencode lists) '
          + 'or authenticate it (`opencode auth login`).')
      }
    }
    const agent = settings.opencodeAgent.trim()
    if (agent && currentValueOf(this.config, 'mode') !== agent) {
      try {
        await this.request('session/set_mode', { sessionId: this.sessionId, modeId: agent }, signal, CONTROL_TIMEOUT_MS)
        this.setCurrent('mode', agent)
      } catch (error) {
        const available = optionValuesOf(this.config, 'mode')
        throw new Error(`opencode has no agent "${agent}" for this session${available.length ? ` (available: ${available.join(', ')})` : ''}. `
          + `Add agents.${agent} to the opencode configuration, or clear the opencode agent of the task type.`)
      }
    }
  }

  /** Read the executor settings, naming the failure so a broken settings read is actionable. */
  private readSettings(): Settings['executor'] {
    try { return this.settings() } catch (error) { throw new Error(`Cannot read the executor settings: ${String(error)}`) }
  }

  /** Add setup guidance to the errors it explains: a missing binary, an unusable provider, an old opencode. */
  private explain(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error)
    if (/ENOENT|not recognized|Cannot find|spawn .* ENOENT|is too old|ACP version|Cannot start the native opencode/i.test(message)) {
      return error instanceof Error ? error : new Error(message)
    }
    if (error instanceof AcpError && (error.code === -32000 || /authentication|free usage limit|provider/i.test(error.message))) {
      const model = this.modelName()
      const guidance = model ? `The ticket's model is "${model}": choose one this machine can use in the task type's model picker.`
        : 'No model is configured for this ticket: choose one in the task type\'s model picker so opencode does not fall back to a model this machine cannot authenticate.'
      return new Error(`${message}. ${SETUP_HINT} ${guidance}`)
    }
    return error instanceof Error ? error : new Error(message)
  }

  /** The `Error` message of an unknown failure. */
  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  /** Update the model the projected assistant messages name from the session's current config. */
  private updateModel(): void {
    this.model = currentValueOf(this.config, 'model') ?? 'opencode'
  }

  /** The opencode model value the shared execution model names: `provider/model`, with `#effort` when a reasoning effort is set. */
  private modelName(): string {
    const model = this.configuredModel()
    return model ? `${model.provider}/${model.model}${model.reasoningEffort ? `#${model.reasoningEffort}` : ''}` : ''
  }

  /** Remember one session config value the response did not echo (a `set_mode`, which answers `{}`). */
  private setCurrent(id: string, value: string): void {
    const option = this.config.find(item => item.id === id)
    if (option) option.currentValue = value
  }

  /** Persist the ACP session id and cwd so a later process can `session/load` the same conversation. */
  private rememberSession(): void {
    if (!this.sessionId) return
    try {
      this.store.set(KV.sessions.opencode(this.agent.id), { engine: 'opencode' satisfies EngineName, sessionId: this.sessionId,
        cwd: this.ticket.execution?.directory ?? process.cwd() })
    } catch (error) {
      this.logger.warn('dsh-superagent could not persist the opencode session id for %s: %s', this.agent.id, String(error))
    }
  }

  /** Drop the stored ACP session: it is gone, created in another cwd, or could not be loaded. */
  private forgetSession(): void {
    this.sessionId = undefined
    try { this.store.set(KV.sessions.opencode(this.agent.id), { engine: 'opencode' satisfies EngineName }) } catch (error) {
      this.logger.warn('dsh-superagent could not clear the opencode session of %s: %s', this.agent.id, String(error))
    }
  }

  /** Start one `session/prompt` turn and settle it on its response, cancellation, or process exit. */
  private runTurn(turn: number, step: number, signal: AbortSignal, prompt: AcpTextBlock[]): Promise<PromptResult> {
    if (this.active) return Promise.reject(new Error('An opencode turn is already running'))
    const sessionId = this.sessionId
    if (!sessionId) return Promise.reject(new Error('The opencode session is not ready'))
    let resolve!: (result: PromptResult) => void
    let reject!: (error: Error) => void
    let stop!: () => void
    const stopped = new Promise<void>(done => { stop = done })
    const promise = new Promise<PromptResult>((res, rej) => { resolve = res; reject = rej })
    const onAbort = () => {
      if (!this.child) { this.failActive(abortError(signal, 'The opencode turn was cancelled')); return }
      try { this.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } }) } catch { this.stopProcess() }
      // Answering the pending cards now keeps the person's UI from waiting on a turn that is ending.
      this.cancelServerRequests()
      void Promise.race([stopped, delay(INTERRUPT_WAIT_MS)]).then(() => {
        if (this.active === active) this.stopProcess()
        this.failActive(abortError(signal, 'The opencode turn was cancelled'))
      })
    }
    const active: ActiveTurn = {
      turn, step, signal, promise, resolve, reject, stopped, stop,
      cleanup: () => signal.removeEventListener('abort', onAbort),
    }
    this.active = active
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    // The prompt's own response settles the turn with its stopReason and usage; it has no request timeout (a turn may run long).
    const id = ++this.nextId
    this.pending.set(id, {
      method: 'session/prompt',
      resolve: value => this.settlePrompt(value),
      reject: error => this.failActive(error),
    })
    try {
      this.write({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId, prompt } })
    } catch (error) {
      this.pending.delete(id)
      this.failActive(error instanceof Error ? error : new Error(String(error)))
    }
    return promise
  }

  /** Settle the active turn with the prompt response, after flushing the last assistant message. */
  private settlePrompt(value: unknown): void {
    this.flushMessage()
    const active = this.active
    if (!active) return
    const record = isRecord(value) ? value : {}
    this.active = undefined
    active.cleanup()
    active.stop()
    active.resolve({ stopReason: asString(record.stopReason), usage: record.usage })
  }

  /** Reject the active turn, if any, with `error`. */
  private failActive(error: Error): void {
    const active = this.active
    if (!active) return
    this.active = undefined
    active.cleanup()
    active.stop()
    active.reject(error)
  }

  /** Write one JSON-RPC line to the opencode process. */
  private write(value: unknown): void {
    const child = this.child
    if (!child || child.stdin.destroyed) throw new Error('The native opencode process is not running')
    child.stdin.write(`${JSON.stringify(value)}\n`)
  }

  /** Send one client-to-agent request and await its response. */
  private request(method: string, params: unknown, signal?: AbortSignal, timeoutMs = 0): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error('The native opencode worker is disposed'))
    if (!this.child) return Promise.reject(new Error('The native opencode process is not running'))
    if (signal?.aborted) return Promise.reject(abortError(signal, `The opencode ${method} request was cancelled`))
    const id = ++this.nextId
    return new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        if (signal && onAbort) signal.removeEventListener('abort', onAbort)
      }
      const settleReject = (error: Error) => {
        if (!this.pending.delete(id)) return
        cleanup()
        reject(error)
      }
      const settleResolve = (value: unknown) => {
        if (!this.pending.delete(id)) return
        cleanup()
        resolve(value)
      }
      this.pending.set(id, { method, resolve: settleResolve, reject: settleReject })
      if (timeoutMs > 0) {
        timer = setTimeout(() => settleReject(new Error(`opencode did not answer ${method} within ${timeoutMs} ms`)), timeoutMs)
        timer.unref?.()
      }
      if (signal) {
        onAbort = () => settleReject(abortError(signal, `The opencode ${method} request was cancelled`))
        signal.addEventListener('abort', onAbort, { once: true })
      }
      try { this.write({ jsonrpc: '2.0', id, method, params }) } catch (error) {
        settleReject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** Handle one stdout line, in order with the lines before it. */
  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim()
    if (!trimmed) return
    let message: unknown
    try { message = JSON.parse(trimmed) } catch {
      // A malformed line is the agent's or a log leak's problem; opencode keeps serving, and so does the bridge.
      this.logger.debug('dsh-superagent opencode printed a non-JSON line for %s: %s', this.agent.id, trimmed.slice(0, 500))
      return
    }
    if (!isRecord(message)) return
    const id = message.id
    const hasId = typeof id === 'number' || typeof id === 'string'
    if (typeof message.method === 'string') {
      if (hasId) this.serverRequest(id as number | string, message.method, message.params)
      else this.notification(message.method, message.params)
      return
    }
    if (!hasId) return
    if (message.error !== undefined || !('result' in message)) this.handleErrorResponse(message)
    else this.handleResultResponse(message)
  }

  /** Answer one agent-to-client request off the read queue, so a card that waits for a person cannot block cancellation. */
  private serverRequest(id: number | string, method: string, params: unknown): void {
    const controller = new AbortController()
    this.serverPending.set(id, { method, controller })
    const run = method === 'session/request_permission'
      ? this.handlePermission(id, params, controller)
      : method === 'elicitation/create'
        ? this.handleElicitation(id, params, controller)
        : Promise.resolve().then(() => this.respondError(id, -32601, `"Method not found": ${method}`))
    void run.catch(error => {
      this.logger.warn('dsh-superagent could not answer the opencode %s request of %s: %s', method, this.agent.id, String(error))
      this.respondCancelled(id, method)
    }).finally(() => { this.serverPending.delete(id) })
  }

  /** Route one agent notification: session updates and the agent's cancellation request. */
  private notification(method: string, params: unknown): void {
    if (method === 'session/update') { this.handleUpdate(params); return }
    if (method === '$/cancel_request') { this.cancelRequest(params); return }
    this.logger.debug('dsh-superagent ignored the opencode notification %s for %s', method, this.agent.id)
  }

  /** Answer the agent's `$/cancel_request` by dropping the pending card it names (it is a notification: no response). */
  private cancelRequest(params: unknown): void {
    const request = isRecord(params) ? params : {}
    const id = request.requestId
    if (typeof id !== 'number' && typeof id !== 'string') return
    const pending = this.serverPending.get(id)
    if (!pending) return
    this.logger.debug('dsh-superagent opencode cancelled its pending %s request %s for %s', pending.method, String(id), this.agent.id)
    pending.controller.abort()
    this.serverPending.delete(id)
  }

  /** Abort every pending card: a cancelled or disposed turn must not leave a question waiting for a person. */
  private cancelServerRequests(): void {
    for (const [id, pending] of [...this.serverPending]) {
      pending.controller.abort()
      this.serverPending.delete(id)
    }
  }

  /** Project one `session/update` notification, discarding child-session and load-replay frames. */
  private handleUpdate(params: unknown): void {
    const frame = isRecord(params) ? params : {}
    const update = isRecord(frame.update) ? frame.update : {}
    const kind = asString(update.sessionUpdate)
    if (!kind) return
    const sessionId = asString(frame.sessionId)
    if (sessionId && this.sessionId && sessionId !== this.sessionId) {
      this.logger.debug('dsh-superagent ignored an opencode %s update for session %s of %s', kind, sessionId, this.agent.id)
      return
    }
    if (isChildUpdate(update)) {
      this.logger.debug('dsh-superagent ignored a child-session %s update for %s', kind, this.agent.id)
      return
    }
    if (this.replaying) {
      // `session/load` replays the history (user/assistant chunks) and ends with the command list; none of it is new.
      if (kind === 'available_commands_update') this.finishReplay()
      else this.logger.debug('dsh-superagent ignored the replayed opencode %s update for %s', kind, this.agent.id)
      return
    }
    switch (kind) {
      case 'agent_message_chunk': this.appendChunk(update, false); return
      case 'agent_thought_chunk': this.appendChunk(update, true); return
      case 'tool_call': this.openToolCall(update); return
      case 'tool_call_update': this.updateToolCall(update); return
      case 'usage_update':
        // `used` is the context size, not the turn's total tokens; token accounting comes from the prompt response.
        this.flushMessage()
        this.logger.debug('dsh-superagent opencode usage for %s: used %s of %s', this.agent.id, String(update.used), String(update.size))
        return
      case 'available_commands_update':
        this.logger.debug('dsh-superagent opencode offered %s commands for %s', Array.isArray(update.availableCommands) ? update.availableCommands.length : 0, this.agent.id)
        return
      case 'user_message_chunk': return
      case 'plan': this.logger.debug('dsh-superagent ignored an opencode plan update for %s', this.agent.id); return
      case 'session_info_update':
      case 'config_option_update':
      case 'compaction_update':
      case 'compaction_summary_chunk':
        this.logger.debug('dsh-superagent ignored the opencode %s update for %s', kind, this.agent.id)
        if (kind === 'config_option_update' && Array.isArray(update.configOptions)) {
          this.config = configOptionsOf(update)
          this.updateModel()
        }
        return
      default: this.logger.debug('dsh-superagent ignored the opencode update %s for %s', kind, this.agent.id)
    }
  }

  /** Buffer one text or thinking chunk; chunks of one message id merge into a single assistant message. */
  private appendChunk(update: Record<string, unknown>, reasoning: boolean): void {
    const content = isRecord(update.content) ? update.content : {}
    if (content.type !== 'text' || typeof content.text !== 'string') return
    const messageId = asString(update.messageId) ?? 'message'
    // Thinking ids are `<assistantMessageId>:reasoning:<n>`: they belong to the same assistant message as the text.
    const id = messageId.split(':reasoning:')[0] || 'message'
    if (this.message && this.message.id !== id) this.flushMessage()
    if (!this.message) this.message = { id, reasoning: '', text: '' }
    if (reasoning) this.message.reasoning += content.text
    else this.message.text += content.text
  }

  /** Project the buffered assistant message, stripped of a worker report line, and remember the report. */
  private flushMessage(): void {
    const buffered = this.message
    this.message = undefined
    if (!buffered) return
    const mapped = assistantContent(buffered.reasoning, buffered.text)
    if (mapped.report) this.pendingReport = mapped.report
    if (!mapped.content.length) return
    const active = this.active
    this.session.append('assistant/message', {
      turn: active?.turn ?? this.lastTurn, step: active?.step ?? this.lastStep,
      message: createAssistantMessage({ content: mapped.content, source: { provider: 'opencode', model: this.model } }),
      stream: [],
    }, { surfaceOp: 'append' })
  }

  /** Remember one opencode tool call; its `tool_call` alone may carry no usable input, so it is projected later. */
  private openToolCall(update: Record<string, unknown>): void {
    const id = asString(update.toolCallId)
    if (!id) return
    this.mergeTool(id, update)
  }

  /** Merge a `tool_call_update`, projecting the call at its first `in_progress` and its result when it completes. */
  private updateToolCall(update: Record<string, unknown>): void {
    const id = asString(update.toolCallId)
    if (!id) return
    const state = this.mergeTool(id, update)
    const status = asString(update.status) ?? state.status
    if (status === 'completed' || status === 'failed') {
      this.toolStates.delete(id)
      // The bridge already logged this call and its result as a question card; the engine's own entries would duplicate them.
      if (this.syntheticResults.delete(id)) return
      this.flushMessage()
      this.appendToolResult(state, status === 'failed')
      return
    }
    if (status === 'in_progress') {
      // The initial `tool_call` may carry `rawInput: {}`; the first update has the arguments the panel should show.
      this.flushMessage()
      this.appendToolCall(state)
    }
  }

  /** Merge one tool notification into its call state. */
  private mergeTool(id: string, update: Record<string, unknown>): ToolState {
    const state = this.toolStates.get(id) ?? { id }
    if (asString(update.name)) state.name = update.name as string
    if (asString(update.kind)) state.kind = update.kind as string
    if (asString(update.title)) state.title = update.title as string
    if (asString(update.status)) state.status = update.status as string
    if (update.rawInput !== undefined) state.rawInput = update.rawInput
    if (Array.isArray(update.locations)) state.locations = update.locations
    if (update.content !== undefined) state.content = update.content
    if (update.rawOutput !== undefined) state.rawOutput = update.rawOutput
    this.toolStates.set(id, state)
    return state
  }

  /** Log one `tool/call` for an opencode call, unless it is a bridged question or was already logged. */
  private appendToolCall(state: ToolState): SessionSeq | undefined {
    const existing = this.callSeq.get(state.id)
    if (existing !== undefined) return existing
    if (this.appendedCalls.has(state.id)) return undefined
    // A `question` tool is represented by its elicitation card, whose synthetic `ask_user_question` call uses this same id.
    if (state.name === 'question') return undefined
    const active = this.active
    const seq = this.session.append('tool/call', {
      turn: active?.turn ?? this.lastTurn, step: active?.step ?? this.lastStep,
      callId: ToolCallId(state.id), name: opencodeToolName(state.name ?? 'tool'), arguments: jsonArguments(state.rawInput ?? {}),
    }).seq
    this.callSeq.set(state.id, seq)
    this.appendedCalls.add(state.id)
    return seq
  }

  /** Log one `tool/result` for a finished opencode call. */
  private appendToolResult(state: ToolState, isError: boolean): void {
    if (state.name === 'question') return
    // A repeated `completed` update must not log the result twice; the bridge already settled this call.
    if (!this.callSeq.has(state.id) && this.appendedCalls.has(state.id)) return
    const seq = this.appendToolCall(state)
    if (seq === undefined && !this.appendedCalls.has(state.id)) return
    const mapped = toolResultFromUpdate(state as unknown as Record<string, unknown>)
    const active = this.active
    this.session.append('tool/result', {
      turn: active?.turn ?? this.lastTurn, step: active?.step ?? this.lastStep,
      message: createToolResultMessage({ callId: ToolCallId(state.id), content: mapped.content, isError }),
      ...(isError ? { error: { name: 'OpencodeToolError', code: 'OPENCODE_TOOL_ERROR' } } : {}),
    }, { surfaceOp: 'append', ...(seq === undefined ? {} : { sourceEventSeqs: [seq] }) })
    this.callSeq.delete(state.id)
  }

  /** Answer one ACP permission request with the configured approval, or with a DSH Allow once / Reject card. */
  private async handlePermission(id: number | string, params: unknown, controller: AbortController): Promise<void> {
    const request = isRecord(params) ? params : {}
    const toolCall = isRecord(request.toolCall) ? request.toolCall : {}
    const toolName = asString(toolCall.name) ?? 'tool'
    const input = toolCall.rawInput ?? {}
    let approval: OpencodeApproval = 'smart'
    try { approval = this.readSettings().opencodeApproval } catch (error) {
      this.logger.warn('dsh-superagent could not read the opencode approval setting for %s: %s', this.agent.id, String(error))
    }
    const choice = permissionChoice({ name: toolName, kind: asString(toolCall.kind) ?? '' }, approval)
    if (choice === 'once') {
      this.respond(id, { outcome: { outcome: 'selected', optionId: 'once' } })
      return
    }
    if (choice === 'reject') {
      this.respond(id, { outcome: { outcome: 'selected', optionId: 'reject' } })
      return
    }
    const callId = `permission:${String(id)}`
    const question = permissionQuestion(toolName, input, {
      engine: 'opencode', denyLabel: 'Reject', denyDescription: 'Refuse this call; opencode then ends the turn.',
    })
    const seq = this.ensureCall(callId, ASK_TOOL, { questions: [toToolQuestion(question)] })
    const answers = await this.ask([question], callId, controller)
    const answer = answers?.find(item => item.id === question.id)
    const allowed = answer?.selected.includes('Allow once') === true
    if (allowed) this.respond(id, { outcome: { outcome: 'selected', optionId: 'once' } })
    else if (answer) this.respond(id, { outcome: { outcome: 'selected', optionId: 'reject' } })
    // opencode treats a cancelled permission as a rejection; the person's card stays honest by failing closed.
    else this.respond(id, { outcome: { outcome: 'cancelled' } })
    this.finishQuestion(callId, seq, answer ? [answer] : [], !allowed)
  }

  /** Bridge one `elicitation/create` form into a single DSH question card and answer it. */
  private async handleElicitation(id: number | string, params: unknown, controller: AbortController): Promise<void> {
    const request = isRecord(params) ? params : {}
    const toolCallId = asString(request.toolCallId) ?? `elicitation:${String(id)}`
    const mapped = questionsFromElicitation(params)
    if (!mapped.questions.length) {
      // A form with no readable field cannot be answered faithfully; declining is the only honest answer.
      this.respond(id, { action: 'decline' })
      return
    }
    const seq = this.ensureCall(toolCallId, ASK_TOOL, { questions: mapped.questions.map(toToolQuestion) })
    const answers = await this.ask(mapped.questions, toolCallId, controller)
    this.syntheticResults.add(toolCallId)
    if (!answers) {
      this.finishQuestion(toolCallId, seq, [], true)
      this.respond(id, { action: controller.signal.aborted ? 'cancel' : 'decline' })
      return
    }
    const reply = elicitationAnswers(mapped.fields, answers)
    this.finishQuestion(toolCallId, seq, answers, reply.action !== 'accept')
    this.respond(id, reply)
  }

  /** Ask DSH's question service and wait for a person's answer; a missing UI, a cancelled turn, or a dead process yields undefined. */
  private async ask(questions: DshQuestion[], callId: string, controller?: AbortController): Promise<DshAnswer[] | undefined> {
    const service = (this.context as unknown as { get(name: string): unknown }).get('userQuestions') as UserQuestionsService | undefined
    if (!service || typeof service.ask !== 'function') {
      this.logger.warn('dsh-superagent has no userQuestions service for the native opencode worker %s', this.agent.id)
      return undefined
    }
    const signal = combineSignals([this.processAbort?.signal, this.active?.signal, controller?.signal])
    try {
      const result = await service.ask({ questions, agent: this.agent, wait: { callId: ToolCallId(callId) }, ...(signal ? { signal } : {}) })
      return Array.isArray(result?.answers) ? result.answers : undefined
    } catch (error) {
      this.logger.warn('dsh-superagent could not ask a person for the native opencode worker %s: %s', this.agent.id, String(error))
      return undefined
    }
  }

  /** Ensure the Session logged a `tool/call` for a bridged question, returning its seq. */
  private ensureCall(callId: string, name: string, argumentsValue: unknown): SessionSeq {
    const existing = this.callSeq.get(callId)
    if (existing !== undefined) return existing
    const active = this.active
    const seq = this.session.append('tool/call', {
      turn: active?.turn ?? this.lastTurn, step: active?.step ?? this.lastStep,
      callId: ToolCallId(callId), name, arguments: JSON.stringify(argumentsValue),
    }).seq
    this.callSeq.set(callId, seq)
    this.appendedCalls.add(callId)
    return seq
  }

  /** Log the answer batch that settles one bridged question in DSH's projection. */
  private finishQuestion(callId: string, seq: SessionSeq, answers: DshAnswer[], isError: boolean): void {
    const active = this.active
    this.session.append('tool/result', {
      turn: active?.turn ?? this.lastTurn, step: active?.step ?? this.lastStep,
      message: createToolResultMessage({ callId: ToolCallId(callId), content: [{ type: 'text', text: JSON.stringify({ answers }) }], isError }),
      ...(isError ? { error: { name: 'OpencodeQuestionError', code: 'OPENCODE_QUESTION_UNAVAILABLE' } } : {}),
    }, { surfaceOp: 'append', sourceEventSeqs: [seq] })
    this.callSeq.delete(callId)
  }

  /** Send one JSON-RPC success response, logging rather than failing when the process already exited. */
  private respond(id: number | string, result: Record<string, unknown>): void {
    try { this.write({ jsonrpc: '2.0', id, result }) } catch (error) {
      this.logger.debug('dsh-superagent could not answer the opencode request %s for %s: %s', String(id), this.agent.id, String(error))
    }
  }

  /** Send one JSON-RPC error response for a request the bridge does not serve. */
  private respondError(id: number | string, code: number, message: string): void {
    try { this.write({ jsonrpc: '2.0', id, error: { code, message } }) } catch (error) {
      this.logger.debug('dsh-superagent could not answer the opencode request %s for %s: %s', String(id), this.agent.id, String(error))
    }
  }

  /** Answer an unanswered server request with the cancellation its kind defines, when its handler failed. */
  private respondCancelled(id: number | string, method: string): void {
    if (method === 'session/request_permission') this.respond(id, { outcome: { outcome: 'cancelled' } })
    else if (method === 'elicitation/create') this.respond(id, { action: 'cancel' })
    else this.respondError(id, -32603, 'Internal error: the bridge could not answer this request')
  }

  /** Resolve one client-to-agent request with its result. */
  private handleResultResponse(message: Record<string, unknown>): void {
    const id = message.id
    if (typeof id !== 'number') return
    const pending = this.pending.get(id)
    if (!pending) return
    pending.resolve(message.result)
  }

  /** Reject one client-to-agent request with its JSON-RPC error. */
  private handleErrorResponse(message: Record<string, unknown>): void {
    const id = message.id
    if (typeof id !== 'number') return
    const pending = this.pending.get(id)
    if (!pending) return
    const error = isRecord(message.error) ? message.error : {}
    const code = typeof error.code === 'number' ? error.code : -32603
    const text = asString(error.message) ?? `opencode failed ${pending.method}`
    pending.reject(new AcpError(code, text, error.data))
  }

  /** Execute a worker report the assistant emitted, through the worker's real `orchestrator_report` tool. */
  private async flushReport(signal: AbortSignal): Promise<void> {
    const report = this.pendingReport
    this.pendingReport = undefined
    if (!report) return
    const result = await recordWorkerReport({
      agent: this.agent, session: this.session, logger: this.logger, report,
      turn: this.lastTurn, step: this.lastStep, callId: ToolCallId(`opencode-report:${++this.reportSeq}`), signal, engine: 'opencode',
    })
    if (result.terminal) this.reportedTerminal = true
  }

  /** Keep the last stderr lines for a process failure message. */
  private rememberStderr(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      this.stderrTail.push(trimmed)
      this.logger.debug('dsh-superagent opencode stderr for %s: %s', this.agent.id, trimmed)
    }
    if (this.stderrTail.length > 40) this.stderrTail = this.stderrTail.slice(-40)
  }

  /** Reject the active turn when the process could not be started or its streams failed. */
  private processFailed(error: Error): void {
    const message = `The native opencode process failed: ${error.message}`
    this.rejectPending(new Error(message))
    this.failActive(new Error(message))
    this.resetProcess()
  }

  /** Reject the active turn and reset the process when opencode exits. */
  private processExited(code: number | null, signal: NodeJS.Signals | null): void {
    const detail = this.stderrTail.join('\n').trim()
    const message = `The native opencode process exited (${code ?? signal ?? 'unknown'})${detail ? `: ${detail.slice(0, 1200)}` : ''}`
    // A process that died while `session/load` was in flight is the opencode equivalent of a failed --resume.
    if (this.loading) this.resumeFailed = true
    this.loading = false
    this.rejectPending(new Error(message))
    const active = this.active
    if (active) this.failActive(new Error(message))
    else if (!this.disposed && code !== 0) {
      this.logger.warn('dsh-superagent native opencode worker %s exited with %s', this.agent.id, code ?? signal ?? 'unknown')
    }
    this.resetProcess()
  }

  /** Reject every in-flight client-to-agent request; the process they were sent to is gone. */
  private rejectPending(error: Error): void {
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) entry.reject(error)
  }

  /** Wait for the end of a `session/load` replay: its trailing `available_commands_update`, or a short fallback timeout. */
  private awaitReplayEnd(): Promise<void> {
    if (!this.replaying) return Promise.resolve()
    return new Promise<void>(resolve => {
      this.replayDone = resolve
      this.replayTimer = setTimeout(() => this.finishReplay(), REPLAY_WAIT_MS)
      this.replayTimer.unref?.()
    })
  }

  /** End the load replay window: the next update is a new turn's. */
  private finishReplay(): void {
    if (this.replayTimer) clearTimeout(this.replayTimer)
    this.replayTimer = undefined
    this.replaying = false
    const done = this.replayDone
    this.replayDone = undefined
    done?.()
  }

  /** Close the process's reader and settle what it was running before the next spawn. */
  private resetProcess(): void {
    try { this.reader?.close() } catch { /* Already closed. */ }
    this.reader = undefined
    this.processAbort?.abort()
    this.processAbort = undefined
    this.child = undefined
    this.ready = false
    this.config = []
    this.loading = false
    this.finishReplay()
    this.serverPending.clear()
    this.message = undefined
    this.toolStates.clear()
    this.callSeq.clear()
  }

  /** Stop the process: close stdin (opencode exits by itself), then kill it after the interrupt wait. */
  private stopProcess(): void {
    const child = this.child
    if (!child) return
    try { child.stdin.end() } catch { /* Already closed. */ }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* Already exited. */ }
    }, INTERRUPT_WAIT_MS)
    timer.unref?.()
    child.once('exit', () => clearTimeout(timer))
  }

  /** Stop the process and release the agent step; the host lifetime and Session release both call this. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.lifetimeListener()
    this.processAbort?.abort()
    this.cancelServerRequests()
    this.failActive(new Error('The native opencode worker was disposed'))
    this.rejectPending(new Error('The native opencode worker was disposed'))
    this.stopProcess()
    try { this.reader?.close() } catch { /* Already closed. */ }
  }
}

/**
 * Attach a native opencode ACP driver to one worker agent.
 * @param options - The worker agent, ticket, store, settings getter and host lifetime.
 * @returns A disposer that restores the loop's step and stops the process.
 */
export function attachOpencode(options: OpencodeOptions): () => void {
  return new OpencodeDriver(options).attach()
}
