/**
 * Native Claude Code worker bridge: keeps one persistent `claude` process per DSH worker Session, projects its
 * stream-json events into the Session log, and routes AskUserQuestion and tool permissions to DSH's question cards.
 *
 * The driver replaces only `ReactLoopAgent.step(decision)`. DSH still owns the turn/step boundaries, the inbox,
 * Session persistence, root registration, status, and the executor's idle/report handling.
 */
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId, createAssistantMessage, createToolResultMessage, type ContentBlock, type ToolSchema, type UserMessage }
  from '@deepseek-ai/dsh-llm'
import type { EpochHeader, SessionSeq } from '@deepseek-ai/dsh-session'
import type { EngineName, Ticket } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { Settings } from '../policy.ts'
import type { Store } from '../app/store.ts'

/** The failure states a worker may report through the `DSH_REPORT` line. */
type ReportState = 'progress' | 'ready' | 'blocked' | 'failed' | 'dropped'
/** What a worker tells the harness at the end of a turn. */
export interface WorkerReport {
  state: ReportState
  summary: string
  human_action?: string
  question_for_trigger_id?: string
  pr_number?: number
  reply_to_trigger_id?: string
}
/** One question in the DSH service's vocabulary. */
export interface DshQuestion {
  id: string
  question: string
  header?: string
  options?: { label: string; description?: string }[]
  multiSelect?: boolean
}
/** One answer as DSH's question service returns it. */
export interface DshAnswer { id: string; selected: string[]; custom?: string }
/** The part of the `userQuestions` service this driver uses. */
interface UserQuestionsService {
  ask(request: { questions: DshQuestion[]; agent?: Agent; signal?: AbortSignal; wait?: { callId: ToolCallId } })
    : Promise<{ answers: DshAnswer[] }>
}
/** A decision handed to the loop's replaced `step`. */
interface StepDecision {
  messages: readonly UserMessage[]
  turn?: number
  step?: number
  signal?: AbortSignal
}
/** The terminal state a replaced step reports to the loop. */
type StepEnd = { kind: 'completed' } | { kind: 'max-tokens' }
/** The loop-owned agent shape the driver replaces. */
type SteppableAgent = Agent & { step: (decision: StepDecision) => Promise<StepEnd | null> }
/** Options used to attach the bridge to one DSH worker agent. */
export interface ClaudeCodeOptions {
  readonly context: Context
  readonly agent: Agent
  readonly ticket: Ticket
  readonly store: Pick<Store, 'get' | 'set'>
  readonly settings: () => Settings['executor']
  readonly logger: Context['logger']
  readonly lifetime: AbortSignal
  /** The execution variables of the ticket, passed to the native process as `DSH_SUPERAGENT_*` environment. */
  readonly environment?: () => { key: string; value: string }[]
  /** Test seam: defaults to `node:child_process.spawn`. */
  readonly spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcessWithoutNullStreams
}
/** One active Claude turn, settled by its `result` event, process exit, or cancellation. */
interface ActiveTurn {
  turn: number
  step: number
  signal: AbortSignal
  promise: Promise<ClaudeResultEvent>
  resolve: (result: ClaudeResultEvent) => void
  reject: (error: Error) => void
  /** Resolves when the CLI acknowledged the interrupt with a result, or the process ended. */
  stopped: Promise<void>
  stop: () => void
  cleanup: () => void
}
/** A loose Claude stream-json event; the bridge narrows each type it handles. */
interface ClaudeEvent { type?: unknown; subtype?: unknown; [key: string]: unknown }
/** A Claude assistant message event. */
interface ClaudeAssistantEvent extends ClaudeEvent {
  message?: { content?: unknown; model?: unknown }
  parent_tool_use_id?: string | null
}
/** A Claude user event carrying tool results. */
interface ClaudeUserEvent extends ClaudeEvent {
  message?: { content?: unknown }
  parent_tool_use_id?: string | null
}
/** A Claude control request event. */
interface ClaudeControlRequestEvent extends ClaudeEvent {
  request_id?: string
  request?: { subtype?: unknown; tool_name?: unknown; input?: unknown; tool_use_id?: unknown; [key: string]: unknown }
}
/** A Claude result event. */
interface ClaudeResultEvent extends ClaudeEvent {
  is_error?: unknown
  result?: unknown
  session_id?: unknown
  stop_reason?: unknown
}
/** A Claude control response event. */
interface ClaudeControlResponseEvent extends ClaudeEvent {
  response?: { subtype?: unknown; request_id?: unknown; error?: unknown }
}

const REPORT_STATES: readonly ReportState[] = ['progress', 'ready', 'blocked', 'failed', 'dropped']
const TERMINAL_STATES: readonly ReportState[] = ['ready', 'blocked', 'failed', 'dropped']
const REPORT_LINE = /^[ \t]*DSH_REPORT[ \t]+(\{.*\})[ \t]*$/gm
const INTERRUPT_WAIT_MS = 1500
const REPORT_TOOL = 'orchestrator_report'
const READ_TOOL = 'orchestrator_read'
const ASK_TOOL = 'ask_user_question'
/** The most resource text one user message carries to Claude; cards hold previews and a read path beyond it. */
const EXPANDED_CHARS = 16_000
/** One `orchestrator_read` page: the tool's maximum. */
const RESOURCE_PAGE = 8_000
/** Resource paths a worker may read and a card may reference. */
const RESOURCE_PATH = /^(?:ticket|trigger|thread|prompts|feishu|github)\/[^\s]+$/
const BRIDGE_PROMPT = [
  'You are the implementation worker for a DeepSeek Harness (DSH) ticket. Work directly in the current directory with your normal tools.',
  'Ticket cards arrive as JSON: ticket_id, title, assignment, and trigger (with trigger_id, preview, read). A referenced resource\'s full text is appended below the card in a <resource path="..."> block; a preview is only a summary.',
  'DSH_SUPERAGENT_NAME is the ticket\'s short name (use it as the branch name when you open a pull request), DSH_SUPERAGENT_DIR is its directory, DSH_SUPERAGENT_TICKET its id, and other DSH_SUPERAGENT_* variables name the repository and accounts.',
  'When you finish, are blocked, fail, drop the work, or make meaningful progress, call no more tools and end your final assistant message with exactly one line:',
  'DSH_REPORT {"state":"ready|blocked|failed|dropped|progress","summary":"one or two sentences","human_action":"optional question for a person","question_for_trigger_id":"optional trigger that raised it","reply_to_trigger_id":"optional trigger this answers","pr_number":123}',
  'Use "ready" for complete work, "progress" before or between long stretches of work, "blocked" when you need a person (put the question in human_action), "failed" when the work failed, and "dropped" when nothing should be done. Include pr_number when you opened or updated a pull request for the ticket so it is claimed, name question_for_trigger_id when the question belongs to a trigger, and reply_to_trigger_id when the report answers one. Omit optional fields you do not need.',
  'Do not put the line in a code fence, do not use it for anything else, and do not mention it to anyone. The harness records it with the ticket\'s report tool; you do not call that tool yourself.',
].join('\n')
/** The timed `ask_user_question` schema the Session must record for DSH's question projection to expose cards. */
const ASK_TOOL_SCHEMA: ToolSchema = {
  name: ASK_TOOL,
  description: 'Ask the user one or more questions and wait for the answer.',
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            question: { type: 'string' },
            header: { type: 'string' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                properties: { label: { type: 'string' }, description: { type: 'string' } },
                required: ['label'],
              },
            },
            multi_select: { type: 'boolean' },
          },
          required: ['id', 'question'],
        },
      },
      timeout: { type: 'integer', description: 'Kept for DSH question-card projection; the native bridge waits without a timeout.' },
    },
    required: ['questions'],
  },
}
const TOOL_NAMES: Readonly<Record<string, string>> = {
  AskUserQuestion: ASK_TOOL, Bash: 'bash', PowerShell: 'pwsh', Read: 'read', Write: 'write', Edit: 'edit', MultiEdit: 'edit',
  Glob: 'glob', Grep: 'grep', WebSearch: 'web_search', WebFetch: 'web_fetch', Task: 'subagent', TodoWrite: 'todo_write',
  NotebookEdit: 'notebook_edit', Skill: 'skill', SendMessage: 'send_message', ListAgents: 'list_agents',
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const asString = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined
const delay = (ms: number): Promise<void> => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.() })
const abortError = (signal?: AbortSignal): Error => signal?.reason instanceof Error ? signal.reason : new Error('The Claude Code turn was cancelled')
/**
 * Collect the worker-readable resource paths a ticket card references, so the native process sees the full text a
 * DSH worker would read on demand instead of only the card's preview.
 * @param value - The parsed user message.
 * @param paths - The set the paths are added to.
 * @param depth - The nesting depth already walked.
 */
function collectResources(value: unknown, paths: Set<string>, depth = 0): void {
  if (depth > 8 || paths.size >= 6) return
  if (Array.isArray(value)) {
    for (const item of value) collectResources(item, paths, depth + 1)
    return
  }
  if (!isRecord(value)) return
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && (key === 'read' || key === 'assignment_read') && RESOURCE_PATH.test(item)) paths.add(item)
    else collectResources(item, paths, depth + 1)
  }
}

/**
 * Resolve the Claude executable: the configured path, `CLAUDE_CODE_BIN`, the per-user install, then PATH.
 * @param configured - The executor's `claudeBin` setting.
 * @returns A path or command name for `spawn`.
 */
export function resolveClaudeBin(configured: string): string {
  const explicit = configured.trim() || process.env.CLAUDE_CODE_BIN?.trim()
  if (explicit) return explicit
  if (process.platform === 'win32') {
    const local = join(homedir(), '.local', 'bin', 'claude.exe')
    if (existsSync(local)) return local
    return 'claude.exe'
  }
  return 'claude'
}

/** Map a Claude tool name to the DSH name the panel renders, leaving unknown tools as Claude named them. */
export function displayToolName(name: string): string {
  return TOOL_NAMES[name] ?? name
}

/** Serialize one Claude tool input for a DSH `tool/call`, normalizing `AskUserQuestion` into DSH question arguments. */
export function toolArguments(name: string, input: unknown): string {
  if (name === 'AskUserQuestion') return JSON.stringify({ questions: questionsFromClaude(input).tool })
  try { return JSON.stringify(input ?? {}) } catch { return '{}' }
}

/**
 * Convert Claude's AskUserQuestion input into DSH's question vocabulary.
 * @param input - The Claude `input` object.
 * @returns `tool` questions (with `multi_select`) and `service` questions (with `multiSelect`) sharing stable ids.
 */
export function questionsFromClaude(input: unknown): { tool: Record<string, unknown>[]; service: DshQuestion[]; texts: string[] } {
  const raw = isRecord(input) && Array.isArray(input.questions) ? input.questions : []
  const service: DshQuestion[] = []
  const texts: string[] = []
  raw.forEach((item, index) => {
    if (!isRecord(item)) return
    const question = asString(item.question)
    if (!question) return
    const options = Array.isArray(item.options) ? item.options.flatMap(option => {
      if (!isRecord(option)) return []
      const label = asString(option.label)
      if (!label) return []
      return [{ label, ...(asString(option.description) ? { description: option.description as string } : {}) }]
    }) : undefined
    service.push({
      id: `q${index + 1}`,
      question,
      ...(asString(item.header) ? { header: item.header as string } : {}),
      ...(options?.length ? { options } : {}),
      ...(item.multiSelect === true ? { multiSelect: true } : {}),
    })
    texts.push(question)
  })
  // A malformed question must not strand the worker: show a generic card and let the turn continue after a click.
  if (!service.length) {
    service.push({ id: 'q1', question: 'Claude Code asked a question with no readable text.', options: [{ label: 'Continue' }] })
    texts.push('')
  }
  return {
    tool: service.map(question => ({
      id: question.id,
      question: question.question,
      ...(question.header ? { header: question.header } : {}),
      ...(question.options ? { options: question.options } : {}),
      ...(question.multiSelect ? { multi_select: true } : {}),
    })),
    service,
    texts,
  }
}

/**
 * Map DSH answers back to Claude's `answers` object, keyed by question text.
 * Multi-select labels join with `, `; a custom answer is appended when present.
 */
export function answersForClaude(questions: readonly DshQuestion[], texts: readonly string[], answers: readonly DshAnswer[]): Record<string, string> {
  const byId = new Map(answers.map(answer => [answer.id, answer]))
  const result: Record<string, string> = {}
  questions.forEach((question, index) => {
    const text = texts[index]
    if (!text) return
    const answer = byId.get(question.id)
    const selected = answer?.selected ?? []
    const custom = answer?.custom?.trim()
    result[text] = custom ? [...selected, custom].join(', ') : selected.join(', ')
  })
  return result
}

/**
 * Build the permission card for one Claude tool call.
 * @param toolName - The Claude tool name, such as `Bash`.
 * @param input - The tool input, summarized for the person.
 * @returns A single-choice question with Allow once and Deny.
 */
export function permissionQuestion(toolName: string, input: unknown): DshQuestion {
  const detail = permissionDetail(toolName, input)
  return {
    id: 'permission',
    header: 'Tool permission',
    question: `Claude Code wants to use ${toolName}${detail ? `:\n${detail}` : ''}\n\nAllow this call?`,
    options: [
      { label: 'Allow once', description: 'Run this tool call now.' },
      { label: 'Deny', description: 'Refuse this tool call.' },
    ],
    multiSelect: false,
  }
}

/** Summarize a tool input for a permission card, preferring the command, path, pattern, URL and task fields people recognize. */
export function permissionDetail(toolName: string, input: unknown): string {
  const record = isRecord(input) ? input : {}
  const parts = [
    asString(record.command) ? `Command: ${record.command}` : undefined,
    asString(record.file_path) ? `Path: ${record.file_path}` : asString(record.path) ? `Path: ${record.path}` : asString(record.notebook_path) ? `Path: ${record.notebook_path}` : undefined,
    asString(record.pattern) ? `Pattern: ${record.pattern}` : undefined,
    asString(record.url) ? `URL: ${record.url}` : undefined,
    asString(record.description) ? `Task: ${record.description}` : undefined,
    asString(record.prompt) ? `Prompt: ${record.prompt}` : undefined,
  ].filter((part): part is string => part !== undefined)
  let detail = parts.join('\n')
  if (!detail) {
    try { detail = JSON.stringify(input ?? {}) } catch { detail = String(input) }
  }
  return detail.length > 1200 ? `${detail.slice(0, 1200)}…` : detail
}

/** Convert a Claude tool result's content into DSH content blocks, replacing images with a text marker. */
export function toolResultContent(content: unknown): ContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (Array.isArray(content)) {
    const blocks = content.flatMap((block): ContentBlock[] => {
      if (typeof block === 'string') return [{ type: 'text', text: block }]
      if (!isRecord(block)) return [{ type: 'text', text: String(block) }]
      if (block.type === 'text' && typeof block.text === 'string') return [{ type: 'text', text: block.text }]
      if (block.type === 'image') return [{ type: 'text', text: '[image]' }]
      try { return [{ type: 'text', text: JSON.stringify(block) }] } catch { return [{ type: 'text', text: String(block) }] }
    })
    return blocks.length ? blocks : [{ type: 'text', text: '' }]
  }
  if (content === undefined || content === null) return [{ type: 'text', text: '' }]
  try { return [{ type: 'text', text: JSON.stringify(content) }] } catch { return [{ type: 'text', text: String(content) }] }
}

/** Parse one worker report object, accepting only a known state and a nonempty summary. */
export function parseWorkerReport(value: unknown): WorkerReport | undefined {
  if (!isRecord(value)) return undefined
  const state = typeof value.state === 'string' && (REPORT_STATES as readonly string[]).includes(value.state) ? value.state as ReportState : undefined
  const summary = typeof value.summary === 'string' ? value.summary.trim() : ''
  if (!state || !summary) return undefined
  const report: WorkerReport = { state, summary }
  if (asString(value.human_action)) report.human_action = (value.human_action as string).trim()
  if (asString(value.question_for_trigger_id)) report.question_for_trigger_id = value.question_for_trigger_id as string
  if (typeof value.pr_number === 'number' && Number.isInteger(value.pr_number) && value.pr_number > 0) report.pr_number = value.pr_number
  if (asString(value.reply_to_trigger_id)) report.reply_to_trigger_id = value.reply_to_trigger_id as string
  return report
}

/**
 * Remove `DSH_REPORT` lines from assistant text and return the last valid report.
 * @param text - One assistant text block as Claude produced it.
 * @returns The visible text and the report, when the text carried one.
 */
export function stripWorkerReport(text: string): { text: string; report?: WorkerReport } {
  let report: WorkerReport | undefined
  const visible = text.replace(REPORT_LINE, (_line, json: string) => {
    try { report = parseWorkerReport(JSON.parse(json)) ?? report } catch { /* Not a valid report; leave the line out and continue. */ }
    return ''
  }).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return { text: visible, ...(report ? { report } : {}) }
}

/** Map Claude assistant content blocks to DSH content and collect a trailing worker report. */
export function mapAssistantContent(content: unknown): { content: ContentBlock[]; report?: WorkerReport } {
  const blocks: ContentBlock[] = []
  let report: WorkerReport | undefined
  if (!Array.isArray(content)) return { content: blocks }
  for (const block of content) {
    if (!isRecord(block)) continue
    switch (block.type) {
      case 'text': {
        if (typeof block.text !== 'string') break
        const parsed = stripWorkerReport(block.text)
        report = parsed.report ?? report
        if (parsed.text) blocks.push({ type: 'text', text: parsed.text })
        break
      }
      case 'thinking': if (asString(block.thinking)) blocks.push({ type: 'reasoning', text: block.thinking as string }); break
      case 'redacted_thinking': blocks.push({ type: 'reasoning', text: '[redacted thinking]' }); break
      case 'tool_use': {
        const id = asString(block.id), name = asString(block.name)
        if (!id || !name) break
        blocks.push({ type: 'tool-call', id: ToolCallId(id), name: displayToolName(name), arguments: toolArguments(name, block.input) })
        break
      }
      default: {
        try { blocks.push({ type: 'text', text: JSON.stringify(block) }) } catch { /* Ignore an unserializable unknown block. */ }
      }
    }
  }
  return { content: blocks, ...(report ? { report } : {}) }
}

/** Convert one DSH user message into Claude's stream-json user content. */
function userContent(message: UserMessage): { type: 'text'; text: string }[] {
  return message.content.flatMap((block): { type: 'text'; text: string }[] => {
    if (block.type === 'text') return [{ type: 'text', text: block.text }]
    if (block.type === 'image') return [{ type: 'text', text: '[image omitted: the native Claude Code process cannot read this attachment]' }]
    if (block.type === 'file') return [{ type: 'text', text: '[file omitted]' }]
    return []
  })
}

/**
 * One persistent native Claude Code process attached to a DSH worker Session.
 * It replaces the agent's model step, maps stream-json events to Session events, and bridges interactions to
 * DSH's `userQuestions` service so the Web UI shows the same question and permission cards as other workers.
 */
export class ClaudeCodeDriver {
  private readonly context: Context
  private readonly agent: Agent
  private readonly session: Agent['session']
  private readonly ticket: Ticket
  private readonly store: Pick<Store, 'get' | 'set'>
  private readonly settings: () => Settings['executor']
  private readonly logger: Context['logger']
  private readonly environment?: () => { key: string; value: string }[]
  private readonly spawnProcess: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcessWithoutNullStreams
  private child?: ChildProcessWithoutNullStreams
  private reader?: Interface
  private processAbort?: AbortController
  private active?: ActiveTurn
  private readonly lifetimeListener: () => void
  private disposed = false
  private headerLogged = false
  private initSeen = false
  private resumeRequested = false
  private resumeFailed = false
  private claudeSessionId?: string
  private model?: string
  private lastTurn = 1
  private lastStep = 1
  private reportSeq = 0
  private readSeq = 0
  private pendingReport?: WorkerReport
  private reportedTerminal = false
  /** Tool-call log seqs that still await a result, by Claude tool-use id. */
  private readonly callSeq = new Map<string, SessionSeq>()
  /** Every Claude tool-use id whose `tool/call` was already logged, including synthetic question calls. */
  private readonly appendedCalls = new Set<string>()
  /** Claude tool-use ids whose result the bridge already logged and whose own result must not duplicate. */
  private readonly syntheticResults = new Set<string>()
  private queue: Promise<void> = Promise.resolve()
  private stderrTail: string[] = []

  constructor(options: ClaudeCodeOptions) {
    this.context = options.context
    this.agent = options.agent
    this.session = options.agent.session
    this.ticket = options.ticket
    this.store = options.store
    this.settings = options.settings
    this.logger = options.logger
    this.environment = options.environment
    this.spawnProcess = options.spawn ?? ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions) as ChildProcessWithoutNullStreams)
    this.claudeSessionId = this.store.get(KV.sessions.claude(this.agent.id))?.sessionId
    const onAbort = () => this.dispose()
    this.lifetimeListener = () => options.lifetime.removeEventListener('abort', onAbort)
    if (options.lifetime.aborted) queueMicrotask(onAbort)
    else options.lifetime.addEventListener('abort', onAbort, { once: true })
  }

  /** Replace the loop's model step with this driver's native Claude turn. */
  attach(): () => void {
    const loop = this.agent as unknown as SteppableAgent
    const original = loop.step
    loop.step = decision => this.step(decision)
    return () => {
      loop.step = original
      this.dispose()
    }
  }

  /** Run one DSH step through Claude: append the claimed messages, send them, and wait for the turn result. */
  async step(decision: StepDecision): Promise<StepEnd | null> {
    if (this.disposed) throw new Error('The native Claude Code worker is disposed')
    const turn = decision.turn ?? this.lastTurn
    const step = decision.step ?? this.lastStep
    const signal = decision.signal ?? (this.agent as unknown as { phase?: { abort?: AbortController } }).phase?.abort?.signal
    if (!signal) throw new Error('The native Claude Code worker needs the turn cancellation signal')
    signal.throwIfAborted()
    this.lastTurn = turn
    this.lastStep = step
    this.reportedTerminal = false
    this.pendingReport = undefined
    let sent = false
    let retried = false
    for (;;) {
      const messages = decision.messages.filter(message => (message.source as { kind?: string }).kind !== 'runtime-context')
      if (!messages.length) return { kind: 'completed' }
      try {
        // The process may have exited after a previous turn or before this one; an exit during a --resume start is what
        // lets the catch below retry the same messages in a fresh native session.
        this.ensureProcess()
        this.logHeader()
        if (!retried) for (const message of messages) this.session.append('user/message', message, { surfaceOp: 'append' })
        for (const message of messages) {
          const content = await this.contentFor(message, signal)
          if (content.length) { this.write({ type: 'user', message: { role: 'user', content } }); sent = true }
        }
        if (!sent) return { kind: 'completed' }
        const result = await this.runTurn(turn, step, signal)
        await this.flushReport(signal)
        if (result.is_error === true || (typeof result.subtype === 'string' && result.subtype !== 'success')) {
          const detail = typeof result.result === 'string' && result.result.trim() ? result.result.trim().slice(0, 1000)
            : `Claude Code ended the turn with ${typeof result.subtype === 'string' ? result.subtype : 'an error'}`
          // A terminal worker report already gave the executor the outcome; do not fail the ticket a second time.
          if (this.reportedTerminal) return { kind: 'completed' }
          throw new Error(detail)
        }
        return result.stop_reason === 'max_tokens' ? { kind: 'max-tokens' } : { kind: 'completed' }
      } catch (error) {
        // A stored Claude session can be gone (a cleaned profile, a changed cwd): retry the same messages once in a fresh native session.
        if (!retried && this.resumeFailed && !signal.aborted) {
          retried = true
          this.resumeFailed = false
          this.claudeSessionId = undefined
          this.store.set(KV.sessions.claude(this.agent.id), { engine: 'claude-code' satisfies EngineName })
          this.resetProcess()
          continue
        }
        throw error
      }
    }
  }

  /** Spawn the persistent Claude process and start its stdout queue. */
  private ensureProcess(): void {
    if (this.child) return
    if (this.disposed) throw new Error('The native Claude Code worker is disposed')
    let settings: Settings['executor']
    try { settings = this.settings() } catch (error) { throw new Error(`Cannot read the executor settings: ${String(error)}`) }
    const bin = resolveClaudeBin(settings.claudeBin)
    const args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-prompt-tool=stdio', '--permission-prompts', 'host', '--permission-mode', settings.claudePermissionMode]
    if (settings.claudeModel) args.push('--model', settings.claudeModel)
    if (settings.claudeEffort) args.push('--effort', settings.claudeEffort)
    // Ultracode is a setting rather than an effort level, so it rides in the additional settings JSON.
    if (settings.claudeUltracode) args.push('--settings', JSON.stringify({ ultracode: true }))
    if (this.claudeSessionId) { args.push('--resume', this.claudeSessionId); this.resumeRequested = true }
    args.push('--append-system-prompt', BRIDGE_PROMPT)
    const cwd = this.ticket.execution?.directory ?? process.cwd()
    const env: NodeJS.ProcessEnv = { ...process.env }
    try {
      for (const variable of this.environment?.() ?? []) {
        if (/^DSH_SUPERAGENT_[A-Z0-9_]+$/.test(variable.key)) env[variable.key] = variable.value
      }
    } catch (error) {
      this.logger.debug('dsh-superagent could not read the execution variables for %s: %s', this.agent.id, String(error))
    }
    env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts'
    let child: ChildProcessWithoutNullStreams
    try {
      child = this.spawnProcess(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      throw new Error(`Cannot start the native Claude Code process (${bin}): ${error instanceof Error ? error.message : String(error)}`)
    }
    this.child = child
    this.processAbort = new AbortController()
    this.initSeen = false
    this.stderrTail = []
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    this.reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.reader.on('line', line => {
      // A replaced process's remaining lines must not land in the next process's active turn.
      this.queue = this.queue.then(() => this.child === child ? this.handleLine(line) : undefined).catch(error => {
        this.logger.warn('dsh-superagent could not handle a Claude Code event for %s: %s', this.agent.id, String(error))
      })
    })
    child.stderr.on('data', (chunk: string | Buffer) => this.rememberStderr(String(chunk)))
    child.stdin.on('error', (error: Error) => this.logger.debug('dsh-superagent Claude Code stdin for %s: %s', this.agent.id, error.message))
    child.on('error', (error: Error) => this.processFailed(error))
    child.on('exit', (code, exitSignal) => this.processExited(code, exitSignal))
    try { this.write({ type: 'control_request', request_id: `initialize:${randomUUID()}`, request: { subtype: 'initialize' } }) }
    catch (error) { this.logger.debug('dsh-superagent could not initialize Claude Code for %s: %s', this.agent.id, String(error)) }
  }

  /** Log the native tool declaration DSH's question projection reads, once per DSH Session. */
  private logHeader(): void {
    if (this.headerLogged) return
    this.headerLogged = true
    const header: EpochHeader = { config: { provider: 'claude-code', model: this.settings().claudeModel || 'claude' }, tools: [ASK_TOOL_SCHEMA] }
    const existing = this.session.requestHeader()
    this.session.append('request/header', { header, reason: existing ? 'change' : 'initial', ...(existing ? { startsSeries: true } : {}) })
  }

  /** Run one Claude turn and settle it on its result, cancellation, or process exit. */
  private runTurn(turn: number, step: number, signal: AbortSignal): Promise<ClaudeResultEvent> {
    if (this.active) throw new Error('A Claude Code turn is already running')
    let resolve!: (result: ClaudeResultEvent) => void
    let reject!: (error: Error) => void
    let stop!: () => void
    const stopped = new Promise<void>(done => { stop = done })
    const promise = new Promise<ClaudeResultEvent>((res, rej) => { resolve = res; reject = rej })
    const onAbort = () => {
      if (!this.child) { reject(abortError(signal)); return }
      try { this.write({ type: 'control_request', request_id: `interrupt:${randomUUID()}`, request: { subtype: 'interrupt' } }) } catch {
        this.stopProcess()
      }
      void Promise.race([stopped, delay(INTERRUPT_WAIT_MS)]).then(() => {
        if (this.active === active) this.stopProcess()
        reject(abortError(signal))
      })
    }
    const active: ActiveTurn = {
      turn, step, signal, promise, resolve, reject, stopped, stop,
      cleanup: () => signal.removeEventListener('abort', onAbort),
    }
    this.active = active
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    return promise
  }

  /** Write one JSON line to the Claude process. */
  private write(value: unknown): void {
    const child = this.child
    if (!child || child.stdin.destroyed) throw new Error('The native Claude Code process is not running')
    child.stdin.write(`${JSON.stringify(value)}\n`)
  }

  /** Turn one user message into Claude content, expanding card resource references to the text a DSH worker would read. */
  private async contentFor(message: UserMessage, signal: AbortSignal): Promise<{ type: 'text'; text: string }[]> {
    const blocks = userContent(message)
    for (const block of blocks) block.text = await this.expandResources(block.text, signal)
    return blocks
  }

  /** Append the full text of the resources a card references, at most {@link EXPANDED_CHARS} per message. */
  private async expandResources(text: string, signal: AbortSignal): Promise<string> {
    let value: unknown
    try { value = JSON.parse(text) } catch { return text }
    if (!isRecord(value)) return text
    const paths = new Set<string>()
    collectResources(value, paths)
    if (!paths.size) return text
    const sections: string[] = []
    let remaining = EXPANDED_CHARS
    for (const path of paths) {
      if (remaining <= 0) break
      const body = await this.readResourceText(path, remaining, signal)
      if (!body) continue
      sections.push(`<resource path="${path}">\n${body}\n</resource>`)
      remaining -= body.length
    }
    return sections.length ? `${text}\n\nThe full text of the referenced resources:\n${sections.join('\n\n')}` : text
  }

  /** Read pages of one resource through the worker's real `orchestrator_read` tool. */
  private async readResourceText(path: string, limit: number, signal: AbortSignal): Promise<string | undefined> {
    if (!this.agent.ctx.tools.get(READ_TOOL)) return undefined
    let output = ''
    let offset = 0
    try {
      while (output.length < limit) {
        const result = await this.agent.ctx.tools.execute({
          callId: ToolCallId(`claude-read:${++this.readSeq}`), name: READ_TOOL,
          arguments: { resource: path, offset, limit: Math.min(RESOURCE_PAGE, limit - output.length) },
          agent: this.agent, signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        })
        if (result.isError) return output || undefined
        const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
        let page: unknown
        try { page = JSON.parse(text) } catch { return `${output}${text}`.slice(0, limit) }
        if (!isRecord(page) || typeof page.text !== 'string') return `${output}${text}`.slice(0, limit)
        output += page.text
        const next = typeof page.next_offset === 'number' ? page.next_offset : undefined
        if (next === undefined || next <= offset) break
        offset = next
      }
    } catch (error) {
      this.logger.debug('dsh-superagent could not read %s for the native Claude Code worker %s: %s', path, this.agent.id, String(error))
      return output || undefined
    }
    return output.slice(0, limit) || undefined
  }

  /** Handle one stdout line, in order with the lines before it. */
  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim()
    if (!trimmed) return
    let event: unknown
    try { event = JSON.parse(trimmed) } catch {
      this.logger.debug('dsh-superagent Claude Code printed a non-JSON line for %s: %s', this.agent.id, trimmed.slice(0, 500))
      return
    }
    if (!isRecord(event)) return
    switch (event.type) {
      case 'system':
        if (event.subtype === 'init') this.systemInit(event)
        return
      case 'assistant':
        this.assistantEvent(event as ClaudeAssistantEvent)
        return
      case 'user':
        this.userEvent(event as ClaudeUserEvent)
        return
      case 'control_request':
        await this.controlRequest(event as ClaudeControlRequestEvent)
        return
      case 'control_response':
        this.controlResponse(event as ClaudeControlResponseEvent)
        return
      case 'result':
        this.resultEvent(event as ClaudeResultEvent)
        return
      default:
        this.logger.debug('dsh-superagent ignored Claude Code event %s for %s', String(event.type), this.agent.id)
    }
  }

  /** Capture the Session id and model from Claude's init event, persisting the id for resume. */
  private systemInit(event: ClaudeEvent): void {
    this.initSeen = true
    this.resumeFailed = false
    if (asString(event.model)) this.model = event.model as string
    if (asString(event.session_id)) this.rememberSession(event.session_id as string)
    this.logger.info('dsh-superagent native Claude Code worker %s initialized (session %s, model %s)',
      this.agent.id, asString(event.session_id) ?? '?', this.model ?? '?')
  }

  /** Persist the Claude session id so a later process can `--resume` the same conversation. */
  private rememberSession(sessionId: string): void {
    if (this.claudeSessionId === sessionId) return
    this.claudeSessionId = sessionId
    try { this.store.set(KV.sessions.claude(this.agent.id), { engine: 'claude-code', sessionId }) }
    catch (error) { this.logger.warn('dsh-superagent could not persist the Claude Code session id for %s: %s', this.agent.id, String(error)) }
  }

  /** Project one top-level assistant message and its tool calls, stripping a worker report line. */
  private assistantEvent(event: ClaudeAssistantEvent): void {
    const active = this.active
    if (!active) { this.logger.debug('dsh-superagent ignored an assistant event outside a turn for %s', this.agent.id); return }
    if (event.parent_tool_use_id) return
    const message = isRecord(event.message) ? event.message : {}
    const mapped = mapAssistantContent(message.content)
    if (mapped.report) this.pendingReport = mapped.report
    if (asString(message.model)) this.model = message.model as string
    if (mapped.content.length) this.session.append('assistant/message', {
      turn: active.turn, step: active.step,
      message: createAssistantMessage({ content: mapped.content, source: { provider: 'claude-code', model: this.model ?? 'claude' } }),
      stream: [],
    }, { surfaceOp: 'append' })
    const blocks = Array.isArray(message.content) ? message.content : []
    for (const block of blocks) {
      if (!isRecord(block) || block.type !== 'tool_use') continue
      const id = asString(block.id), name = asString(block.name)
      if (!id || !name || this.appendedCalls.has(id)) continue
      const seq = this.session.append('tool/call', {
        turn: active.turn, step: active.step, callId: ToolCallId(id), name: displayToolName(name), arguments: toolArguments(name, block.input),
      }).seq
      this.callSeq.set(id, seq)
      this.appendedCalls.add(id)
    }
  }

  /** Project top-level tool results Claude produced, skipping results the bridge already logged. */
  private userEvent(event: ClaudeUserEvent): void {
    const active = this.active
    if (!active || event.parent_tool_use_id) return
    const message = isRecord(event.message) ? event.message : {}
    if (!Array.isArray(message.content)) return
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== 'tool_result') continue
      const id = asString(block.tool_use_id)
      if (!id) continue
      if (this.syntheticResults.delete(id)) continue
      const seq = this.callSeq.get(id)
      this.callSeq.delete(id)
      const isError = block.is_error === true
      this.session.append('tool/result', {
        turn: active.turn, step: active.step,
        message: createToolResultMessage({ callId: ToolCallId(id), content: toolResultContent(block.content), isError }),
        ...(isError ? { error: { name: 'ClaudeToolError', code: 'CLAUDE_TOOL_ERROR' } } : {}),
      }, { surfaceOp: 'append', ...(seq === undefined ? {} : { sourceEventSeqs: [seq] }) })
    }
  }

  /** Answer Claude's permission and question control requests from DSH's Web UI. */
  private async controlRequest(event: ClaudeControlRequestEvent): Promise<void> {
    const requestId = asString(event.request_id)
    const request = isRecord(event.request) ? event.request : {}
    const subtype = asString(request.subtype)
    if (!requestId) return
    if (!this.active) {
      this.respond(requestId, { behavior: 'deny', message: 'The Claude Code turn is no longer running.' })
      return
    }
    if (subtype === 'can_use_tool') {
      if (asString(request.tool_name) === 'AskUserQuestion') await this.askClaude(event, requestId)
      else await this.askPermission(event, requestId)
      return
    }
    if (subtype === 'request_user_dialog') {
      this.respond(requestId, { behavior: 'cancelled' })
      return
    }
    this.respond(requestId, {}, `Unsupported Claude Code control request: ${subtype ?? 'unknown'}`)
  }

  /** Bridge Claude's AskUserQuestion into one DSH question batch and return the answers in `updatedInput.answers`. */
  private async askClaude(event: ClaudeControlRequestEvent, requestId: string): Promise<void> {
    const request = isRecord(event.request) ? event.request : {}
    const input = isRecord(request.input) ? request.input : {}
    const toolUseId = asString(request.tool_use_id) ?? `ask:${requestId}`
    const questions = questionsFromClaude(input)
    const seq = this.ensureCall(toolUseId, ASK_TOOL, { questions: questions.tool })
    const answers = await this.ask(questions.service, toolUseId)
    if (!answers) {
      this.respond(requestId, { behavior: 'deny', message: 'The user did not answer the question.' })
      this.finishQuestion(toolUseId, seq, [], true)
      return
    }
    this.syntheticResults.add(toolUseId)
    this.finishQuestion(toolUseId, seq, answers, false)
    this.respond(requestId, { behavior: 'allow', updatedInput: { ...input, answers: answersForClaude(questions.service, questions.texts, answers) } })
  }

  /**
   * Answer one tool permission with the configured approval, or with a DSH Allow once / Deny card when it asks a person.
   * `approve` and `deny` keep an unattended Ticket from waiting on the Web UI; `AskUserQuestion` still asks a person.
   */
  private async askPermission(event: ClaudeControlRequestEvent, requestId: string): Promise<void> {
    const request = isRecord(event.request) ? event.request : {}
    const toolName = asString(request.tool_name) ?? 'unknown'
    const input = request.input
    // A settings read that fails must not leave Claude waiting for an answer; fall back to asking a person.
    let approval: Settings['executor']['claudeApproval'] = 'ask'
    try { approval = this.settings().claudeApproval } catch (error) {
      this.logger.warn('dsh-superagent could not read the Claude Code approval setting for %s: %s', this.agent.id, String(error))
    }
    if (approval !== 'ask') {
      this.logger.debug('dsh-superagent %s the %s call of %s without a person', approval === 'approve' ? 'allowed' : 'denied', toolName,
        this.agent.id)
      this.respond(requestId, approval === 'approve' ? { behavior: 'allow', updatedInput: isRecord(input) ? { ...input } : {} }
        : { behavior: 'deny', message: 'Claude Code is configured to deny tool calls that need approval.' })
      return
    }
    const callId = `permission:${requestId}`
    const question = permissionQuestion(toolName, input)
    const seq = this.ensureCall(callId, ASK_TOOL, { questions: [toToolQuestion(question)] })
    const answers = await this.ask([question], callId)
    const answer = answers?.find(item => item.id === question.id)
    const allowed = answer?.selected.includes('Allow once') === true
    if (allowed) {
      this.respond(requestId, { behavior: 'allow', updatedInput: isRecord(input) ? { ...input } : {} })
      this.finishQuestion(callId, seq, answer ? [answer] : [], false)
      return
    }
    const message = answer?.custom?.trim() || (answer?.selected.includes('Deny') ? 'The user denied this tool call.' : 'The user did not answer the permission request.')
    this.respond(requestId, { behavior: 'deny', message })
    this.finishQuestion(callId, seq, answer ? [answer] : [], false)
  }

  /** Ask DSH's question service and wait for a person's answer; a missing UI or a dead process yields undefined. */
  private async ask(questions: DshQuestion[], callId: string): Promise<DshAnswer[] | undefined> {
    const service = (this.context as unknown as { get(name: string): unknown }).get('userQuestions') as UserQuestionsService | undefined
    if (!service || typeof service.ask !== 'function') {
      this.logger.warn('dsh-superagent has no userQuestions service for the native Claude Code worker %s', this.agent.id)
      return undefined
    }
    const abort = this.processAbort
    const signal = abort ? AbortSignal.any([abort.signal, ...(this.active ? [this.active.signal] : [])]) : this.active?.signal
    try {
      const result = await service.ask({
        questions, agent: this.agent, wait: { callId: ToolCallId(callId) }, ...(signal ? { signal } : {}),
      })
      return Array.isArray(result?.answers) ? result.answers : undefined
    } catch (error) {
      this.logger.warn('dsh-superagent could not ask a person for the native Claude Code worker %s: %s', this.agent.id, String(error))
      return undefined
    }
  }

  /** Ensure the Session logged a `tool/call` for a bridged question, returning its seq. */
  private ensureCall(callId: string, name: string, argumentsValue: unknown): SessionSeq {
    const existing = this.callSeq.get(callId)
    if (existing !== undefined) return existing
    if (this.appendedCalls.has(callId)) {
      // The call was logged and its result already settled before Claude repeated it; keep the call out of the active map.
      const active = this.active
      const seq = this.session.append('tool/call', {
        turn: active?.turn ?? this.lastTurn, step: active?.step ?? this.lastStep,
        callId: ToolCallId(callId), name, arguments: JSON.stringify(argumentsValue),
      }).seq
      return seq
    }
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
      message: createToolResultMessage({
        callId: ToolCallId(callId), content: [{ type: 'text', text: JSON.stringify({ answers }) }], isError,
      }),
      ...(isError ? { error: { name: 'ClaudeQuestionError', code: 'CLAUDE_QUESTION_UNAVAILABLE' } } : {}),
    }, { surfaceOp: 'append', sourceEventSeqs: [seq] })
    this.callSeq.delete(callId)
  }

  /** Send one control response, logging rather than failing when the process already exited. */
  private respond(requestId: string, response: Record<string, unknown>, error?: string): void {
    try {
      this.write(error
        ? { type: 'control_response', response: { subtype: 'error', request_id: requestId, error } }
        : { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
    } catch (cause) {
      this.logger.debug('dsh-superagent could not answer Claude Code control request %s for %s: %s', requestId, this.agent.id, String(cause))
    }
  }

  /** Read the initialize response's error, when it reported one. */
  private controlResponse(event: ClaudeControlResponseEvent): void {
    const response = isRecord(event.response) ? event.response : {}
    if (response.subtype === 'error') this.logger.warn('dsh-superagent Claude Code control request %s failed for %s: %s',
      String(response.request_id), this.agent.id, String(response.error))
  }

  /** Settle the active turn with Claude's result. */
  private resultEvent(event: ClaudeResultEvent): void {
    if (asString(event.session_id)) this.rememberSession(event.session_id as string)
    const active = this.active
    if (!active) return
    this.active = undefined
    active.cleanup()
    active.stop()
    active.resolve(event)
  }

  /** Execute a worker report the assistant emitted, through the worker's real `orchestrator_report` tool. */
  private async flushReport(signal: AbortSignal): Promise<void> {
    const report = this.pendingReport
    this.pendingReport = undefined
    if (!report) return
    const tool = this.agent.ctx.tools.get(REPORT_TOOL)
    if (!tool) {
      this.logger.warn('dsh-superagent Claude Code worker %s reported %s but the worker has no %s tool', this.agent.id, report.state, REPORT_TOOL)
      return
    }
    const callId = ToolCallId(`claude-report:${++this.reportSeq}`)
    const callSeq = this.session.append('tool/call', {
      turn: this.lastTurn, step: this.lastStep, callId, name: REPORT_TOOL, arguments: JSON.stringify(report),
    }).seq
    let content: ContentBlock[] = [{ type: 'text', text: 'The report was recorded.' }]
    let isError = false
    try {
      const result = await this.agent.ctx.tools.execute({
        callId, name: REPORT_TOOL, arguments: report, agent: this.agent,
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      })
      content = result.content.length ? [...result.content] : content
      isError = result.isError
    } catch (error) {
      isError = true
      content = [{ type: 'text', text: `The worker report could not be recorded: ${error instanceof Error ? error.message : String(error)}` }]
    }
    if (!isError && TERMINAL_STATES.includes(report.state)) this.reportedTerminal = true
    this.session.append('tool/result', {
      turn: this.lastTurn, step: this.lastStep,
      message: createToolResultMessage({ callId, content, isError }),
      ...(isError ? { error: { name: 'WorkerReportError', code: 'WORKER_REPORT_FAILED' } } : {}),
    }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
  }

  /** Keep the last stderr lines for a process failure message. */
  private rememberStderr(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      this.stderrTail.push(trimmed)
      this.logger.debug('dsh-superagent Claude Code stderr for %s: %s', this.agent.id, trimmed)
    }
    if (this.stderrTail.length > 40) this.stderrTail = this.stderrTail.slice(-40)
  }

  /** Reject the active turn when the process could not be started or its streams failed. */
  private processFailed(error: Error): void {
    const active = this.active
    this.active = undefined
    active?.cleanup()
    active?.stop()
    active?.reject(new Error(`The native Claude Code process failed: ${error.message}`))
    this.resetProcess()
  }

  /** Reject the active turn and reset the process when Claude exits. */
  private processExited(code: number | null, signal: NodeJS.Signals | null): void {
    const wasResume = this.resumeRequested && !this.initSeen
    this.resumeRequested = false
    if (wasResume) this.resumeFailed = true
    const active = this.active
    this.active = undefined
    active?.cleanup()
    active?.stop()
    if (active) {
      const detail = this.stderrTail.join('\n').trim()
      active.reject(new Error(`The native Claude Code process exited (${code ?? signal ?? 'unknown'})${detail ? `: ${detail.slice(0, 1200)}` : ''}`))
    } else if (!this.disposed && code !== 0) {
      this.logger.warn('dsh-superagent native Claude Code worker %s exited with %s', this.agent.id, code ?? signal ?? 'unknown')
    }
    this.resetProcess()
  }

  /** Close the process's reader and abort any pending question before the next spawn. */
  private resetProcess(): void {
    try { this.reader?.close() } catch { /* Already closed. */ }
    this.reader = undefined
    this.processAbort?.abort()
    this.processAbort = undefined
    this.child = undefined
    this.callSeq.clear()
  }

  /** Stop the process after an interrupt, or when the driver is disposed. */
  private stopProcess(): void {
    const child = this.child
    if (!child) return
    try { child.stdin.end() } catch { /* Already closed. */ }
    try { child.kill() } catch { /* Already exited. */ }
  }

  /** Stop the process and release the agent step; the host lifetime and Session release both call this. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.lifetimeListener()
    this.processAbort?.abort()
    const active = this.active
    this.active = undefined
    active?.cleanup()
    active?.stop()
    active?.reject(new Error('The native Claude Code worker was disposed'))
    this.stopProcess()
    try { this.reader?.close() } catch { /* Already closed. */ }
  }
}

/** Convert a service question to the tool-schema spelling used in `tool/call` arguments. */
function toToolQuestion(question: DshQuestion): Record<string, unknown> {
  return {
    id: question.id,
    question: question.question,
    ...(question.header ? { header: question.header } : {}),
    ...(question.options ? { options: question.options } : {}),
    ...(question.multiSelect ? { multi_select: true } : {}),
  }
}

/**
 * Attach a native Claude Code driver to one worker agent.
 * @param options - The worker agent, ticket, store, settings getter and host lifetime.
 * @returns A disposer that restores the loop's step and stops the process.
 */
export function attachClaudeCode(options: ClaudeCodeOptions): () => void {
  return new ClaudeCodeDriver(options).attach()
}
