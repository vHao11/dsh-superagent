/**
 * Helpers the two native engine drivers share: the worker report protocol (`DSH_REPORT`), reading the resources a ticket
 * card references through the worker's own `orchestrator_read` tool, the question and permission cards DSH's Web UI renders,
 * and the tool-name, argument and result mappings both engines project into the Session log.
 *
 * The Claude Code driver keeps its Claude-specific content and question mappings; this module holds only what an opencode
 * ACP driver needs in the same form, so the two engines cannot drift apart in how a worker reports or asks a person.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId, createToolResultMessage, type ContentBlock, type ToolSchema, type UserMessage } from '@deepseek-ai/dsh-llm'

/** The failure states a worker may report through the `DSH_REPORT` line. */
export type ReportState = 'progress' | 'ready' | 'blocked' | 'failed' | 'dropped'
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
/** The part of the `userQuestions` service a native driver uses. */
export interface UserQuestionsService {
  ask(request: { questions: DshQuestion[]; agent?: Agent; signal?: AbortSignal; wait?: { callId: ToolCallId } })
    : Promise<{ answers: DshAnswer[] }>
}
/** A decision handed to the loop's replaced `step`. */
export interface StepDecision {
  messages: readonly UserMessage[]
  turn?: number
  step?: number
  signal?: AbortSignal
}
/** The terminal state a replaced step reports to the loop. */
export type StepEnd = { kind: 'completed' } | { kind: 'max-tokens' }
/** The loop-owned agent shape a native driver replaces. */
export type SteppableAgent = Agent & { step: (decision: StepDecision) => Promise<StepEnd | null> }

const REPORT_STATES: readonly ReportState[] = ['progress', 'ready', 'blocked', 'failed', 'dropped']
const TERMINAL_STATES: readonly ReportState[] = ['ready', 'blocked', 'failed', 'dropped']
const REPORT_LINE = /^[ \t]*DSH_REPORT[ \t]+(\{.*\})[ \t]*$/gm
/** How long an interrupted native turn waits for its own acknowledgement before the process is stopped. */
export const INTERRUPT_WAIT_MS = 1500
/** The worker tool a `DSH_REPORT` line is recorded through. */
export const REPORT_TOOL = 'orchestrator_report'
/** The worker tool a card's resource references are read through. */
export const READ_TOOL = 'orchestrator_read'
/** The synthetic tool a bridged question or permission card is logged as. */
export const ASK_TOOL = 'ask_user_question'
/** The most resource text one user message carries to a native engine; cards hold previews and a read path beyond it. */
const EXPANDED_CHARS = 16_000
/** One `orchestrator_read` page: the tool's maximum. */
const RESOURCE_PAGE = 8_000
/** Resource paths a worker may read and a card may reference. */
const RESOURCE_PATH = /^(?:ticket|trigger|thread|prompts|feishu|github)\/[^\s]+$/
/** The bridge rules a native worker runs under; Claude gets them as a system prompt, opencode at the head of its first turn. */
export const BRIDGE_PROMPT = [
  'You are the implementation worker for a DeepSeek Harness (DSH) ticket. Work directly in the current directory with your normal tools.',
  'Ticket cards arrive as JSON: ticket_id, title, assignment, and trigger (with trigger_id, preview, read). A referenced resource\'s full text is appended below the card in a <resource path="..."> block; a preview is only a summary.',
  'DSH_SUPERAGENT_NAME is the ticket\'s short name (use it as the branch name when you open a pull request), DSH_SUPERAGENT_DIR is its directory, DSH_SUPERAGENT_TICKET its id, and other DSH_SUPERAGENT_* variables name the repository and accounts.',
  'When you finish, are blocked, fail, drop the work, or make meaningful progress, call no more tools and end your final assistant message with exactly one line:',
  'DSH_REPORT {"state":"ready|blocked|failed|dropped|progress","summary":"one or two sentences","human_action":"optional question for a person","question_for_trigger_id":"optional trigger that raised it","reply_to_trigger_id":"optional trigger this answers","pr_number":123}',
  'Use "ready" for complete work, "progress" before or between long stretches of work, "blocked" when you need a person (put the question in human_action), "failed" when the work failed, and "dropped" when nothing should be done. Include pr_number when you opened or updated a pull request for the ticket so it is claimed, name question_for_trigger_id when the question belongs to a trigger, and reply_to_trigger_id when the report answers one. Omit optional fields you do not need.',
  'Do not put the line in a code fence, do not use it for anything else, and do not mention it to anyone. The harness records it with the ticket\'s report tool; you do not call that tool yourself.',
].join('\n')
/** The timed `ask_user_question` schema the Session must record for DSH's question projection to expose cards. */
export const ASK_TOOL_SCHEMA: ToolSchema = {
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

/** Whether `value` is a plain JSON object. */
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
/** `value` when it is a nonempty string. */
export const asString = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined
/** Resolve after `ms`, in a timer that does not hold the process open. */
export const delay = (ms: number): Promise<void> => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.() })
/** The error a cancelled native turn rejects with: the signal's own reason when it has one. */
export const abortError = (signal: AbortSignal | undefined, message: string): Error =>
  signal?.reason instanceof Error ? signal.reason : new Error(message)
/** Serialize tool arguments the way a DSH `tool/call` expects, never throwing on a hostile input. */
export function jsonArguments(input: unknown): string {
  try { return JSON.stringify(input ?? {}) } catch { return '{}' }
}
/** Map a native tool name to the DSH name the panel renders, leaving unknown tools as the engine named them. */
export const mapToolName = (name: string, names: Readonly<Record<string, string>>): string => names[name] ?? name

/** Convert a tool result's content into DSH content blocks, replacing images with a text marker. */
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
 * @param text - One assistant text block as the engine produced it.
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

/**
 * Build the permission card for one native tool call.
 * @param toolName - The engine's tool name, such as `Bash` or `shell`.
 * @param input - The tool input, summarized for the person.
 * @param options - The engine's name on the card and its refusal label; defaults reproduce Claude Code's card exactly.
 * @returns A single-choice question with Allow once and the engine's refusal option.
 */
export function permissionQuestion(toolName: string, input: unknown,
  options: { engine?: string; denyLabel?: string; denyDescription?: string } = {}): DshQuestion {
  const detail = permissionDetail(toolName, input)
  return {
    id: 'permission',
    header: 'Tool permission',
    question: `${options.engine ?? 'Claude Code'} wants to use ${toolName}${detail ? `:\n${detail}` : ''}\n\nAllow this call?`,
    options: [
      { label: 'Allow once', description: 'Run this tool call now.' },
      { label: options.denyLabel ?? 'Deny', description: options.denyDescription ?? 'Refuse this tool call.' },
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

/** Convert a service question to the tool-schema spelling used in `tool/call` arguments. */
export function toToolQuestion(question: DshQuestion): Record<string, unknown> {
  return {
    id: question.id,
    question: question.question,
    ...(question.header ? { header: question.header } : {}),
    ...(question.options ? { options: question.options } : {}),
    ...(question.multiSelect ? { multi_select: true } : {}),
  }
}

/** Convert one DSH user message into the text blocks a native engine's prompt carries. */
export function textContent(message: UserMessage, imageNote: string): { type: 'text'; text: string }[] {
  return message.content.flatMap((block): { type: 'text'; text: string }[] => {
    if (block.type === 'text') return [{ type: 'text', text: block.text }]
    if (block.type === 'image') return [{ type: 'text', text: `[image omitted: ${imageNote}]` }]
    if (block.type === 'file') return [{ type: 'text', text: '[file omitted]' }]
    return []
  })
}

/**
 * Collect the worker-readable resource paths a ticket card references, so a native process sees the full text a DSH worker
 * would read on demand instead of only the card's preview.
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
 * Reads the full text of the resources a ticket card references through the worker's own `orchestrator_read` tool, and
 * appends it to the card message. One instance per native driver: the read call ids it allocates are unique within it.
 */
export class CardResources {
  private seq = 0
  constructor(private readonly agent: Agent, private readonly logger: Context['logger'], private readonly engine: string,
    private readonly callPrefix: string) {}

  /** Append the full text of the resources a card references, at most {@link EXPANDED_CHARS} per message. */
  async expand(text: string, signal: AbortSignal): Promise<string> {
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
          callId: ToolCallId(`${this.callPrefix}:${++this.seq}`), name: READ_TOOL,
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
      this.logger.debug('dsh-superagent could not read %s for the native %s worker %s: %s', path, this.engine, this.agent.id, String(error))
      return output || undefined
    }
    return output.slice(0, limit) || undefined
  }
}

/** Everything {@link recordWorkerReport} needs to record one worker report through the worker's own tool. */
export interface WorkerReportRecord {
  readonly agent: Agent
  readonly session: Agent['session']
  readonly logger: Context['logger']
  readonly report: WorkerReport
  readonly turn: number
  readonly step: number
  /** The `tool/call` id of the synthetic report call, unique within the driver. */
  readonly callId: ToolCallId
  readonly signal: AbortSignal
  /** The engine, as its log lines name it: `Claude Code` or `opencode`. */
  readonly engine: string
}

/**
 * Execute a worker report the assistant emitted, through the worker's real `orchestrator_report` tool, and log the call and
 * result in the Session. A terminal report is reported back so the caller can keep the executor from failing the ticket a
 * second time when the engine also ends the turn with an error status.
 */
export async function recordWorkerReport(record: WorkerReportRecord): Promise<{ isError: boolean; terminal: boolean }> {
  const { agent, session, logger, report, turn, step, callId, signal, engine } = record
  const tool = agent.ctx.tools.get(REPORT_TOOL)
  if (!tool) {
    logger.warn('dsh-superagent %s worker %s reported %s but the worker has no %s tool', engine, agent.id, report.state, REPORT_TOOL)
    return { isError: false, terminal: false }
  }
  const callSeq = session.append('tool/call', {
    turn, step, callId, name: REPORT_TOOL, arguments: JSON.stringify(report),
  }).seq
  let content: ContentBlock[] = [{ type: 'text', text: 'The report was recorded.' }]
  let isError = false
  try {
    const result = await agent.ctx.tools.execute({
      callId, name: REPORT_TOOL, arguments: report, agent,
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    })
    content = result.content.length ? [...result.content] : content
    isError = result.isError
  } catch (error) {
    isError = true
    content = [{ type: 'text', text: `The worker report could not be recorded: ${error instanceof Error ? error.message : String(error)}` }]
  }
  session.append('tool/result', {
    turn, step,
    message: createToolResultMessage({ callId, content, isError }),
    ...(isError ? { error: { name: 'WorkerReportError', code: 'WORKER_REPORT_FAILED' } } : {}),
  }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
  return { isError, terminal: !isError && TERMINAL_STATES.includes(report.state) }
}

/** Every engine whose worker reports through `DSH_REPORT` shares these helpers. */
