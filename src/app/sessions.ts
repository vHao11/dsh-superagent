/** Lifecycle, prompt/tool/skill decoration, message delivery, and budget retry tracking for orchestrator and worker DSH sessions. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { dirname } from 'node:path'
import { z } from 'zod'
import { key, liveTicket, type EngineName, type Ticket } from '../core/index.ts'
import { mandateInstructions, ticketOfSession } from '../executor/dsh.ts'
import { BQA_MCP_SERVER, BQA_MCP_TOOL_NAMES } from '../sources/bqa.ts'
import { attachClaudeCode } from '../executor/claude-code.ts'
import { attachOpencode } from '../executor/opencode.ts'
import { claudeSettingsForTicket, opencodeSettingsForTicket, ticketModel } from './executor-profile.ts'
import type { HealthEntry } from '../infra/health.ts'
import { AgentDelivery, messageId } from './delivery.ts'
import type { Effects } from './effects.ts'
import type { Variable } from './execution-environment.ts'
import { RetryHealth } from './retry-health.ts'
import { initializeRoleModel } from './role-models.ts'
import { bundledSkills } from './skill-files.ts'
import { SKILL_PREFIX, type PromptVersion, type Prompts } from './prompts.ts'
import type { Store } from './store.ts'
import { KV } from '../kv.ts'
import type { RegisterTool, Tool } from './tools/tool.ts'

/** Host dependencies used by `Sessions`. */
export interface SessionsHost {
  /** DSH Cordis context: sessions, agents, persistence, and their events. */
  readonly context: Context
  readonly store: Pick<Store, 'tickets' | 'settings' | 'get' | 'set' | 'keys'>
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'compose' | 'skills'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle' | 'idle' | 'pending'>
  /** The `models` health entry, which reports managed sessions waiting on a model-budget retry. */
  readonly health: HealthEntry
  readonly masterId: string
  readonly lifetime: AbortSignal
  closing(): boolean
  /** Execution environment variables for `ticket`, rendered into its worker's system prompt. */
  environment(ticket: Ticket): Variable[]
  /** Tools to register on the main Session (`ticket === undefined`) or on `ticket`'s worker Session. */
  tools(agent: Agent, ticket?: Ticket): Tool[]
}

/**
 * What Sessions registered for an agent it decorated: the releases of its prompt section, tools and skill scope, the scope
 * its skills are registered in, and the skills of one prompt revision; for a worker's subagent, only its tool limits.
 */
interface SessionBinding { disposers: (() => void)[]; scope?: Context; skills?: { revision: number; dispose: () => void }; subagent?: true }

/** The agent presets Executor Sessions and the main Session are created with, which the bundle's patch defines. */
export const WORKER_PRESET = 'dsh-superagent-worker', READONLY_WORKER_PRESET = 'dsh-superagent-worker-readonly', ROUTER_PRESET = 'dsh-superagent-router'
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** DSH's agent preset registry selected `agentPreset` for a Session. */
    'agent-preset/selected'(sessionId: string, agentPreset: string): void
  }
}
/**
 * The DSH tools an Executor Session works with: files, search, the shell and its jobs, the web, skills, its todo list and
 * subagents. It gets no other tool the profile has, whenever it was registered: none that asks or shows a person something,
 * changes the profile, schedules work or starts goals outside the worker slots, the pause and a person's hold, starts or
 * messages other Sessions, or edits documents.
 */
const WORK_TOOLS = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash', 'pwsh', 'job_output', 'job_list', 'job_kill', 'web_search',
  'web_fetch', 'skill', 'todo_write', 'subagent', 'list_subagent_models', 'send_message', 'list_agents', 'interrupt_agent']
/** The work tools a read-only ticket's Executor Session is offered: only the skills and the BQA read-only MCP retrieval tools. */
const READ_ONLY_WORK_TOOLS = ['skill', ...BQA_MCP_TOOL_NAMES.map(name => `mcp__${BQA_MCP_SERVER}__${name}`)]
/** The work tools an Executor Session is offered; a read-only ticket's Session gets only its retrieval surface. */
export const workToolsFor = (readOnly: boolean): readonly string[] => readOnly ? READ_ONLY_WORK_TOOLS : WORK_TOOLS
/** The deployment permission preset a read-only ticket's worker runs under: the read-only file sandbox, paired with its own approvals policy below. */
export const READ_ONLY_PRESET = 'read-only'
/** The shell tool DSH registers on this platform: Windows registers `pwsh`, other platforms `bash`; `tools.restrict` refuses a name no tool registers. */
const SHELL_TOOL = process.platform === 'win32' ? 'pwsh' : 'bash'
/** The approval service seam as `Sessions` uses it: disable interactive approvals on an unattended read-only worker. */
type ApprovalSeam = { setPolicy?: (agent: Agent, policy: 'never') => void }
/** Whether a ticket's task type runs its worker read-only; the flag is snapshotted onto the ticket at accept time. */
const readOnlyOfTicket = (ticket: Ticket | undefined): boolean => ticket?.execution?.readOnly === true

/** What the main Session is told when it would wait: what it waits for comes to it, and a waiting step holds back the next. */
const NO_WAIT = 'Reports, follow_up notices, new candidates and a background job\'s end with its output arrive by themselves as messages; '
  + 'end the turn instead of waiting for them.'
/** What a main Session under `standard` is told when its command would wait the shell's default. */
const DEFAULT_WAIT = 'This shell waits up to 60 seconds by default: pass timeoutMs of at most 30000, or run_in_background, '
  + 'as a waiting step holds back new candidates.'
/** `sleep` at a command position: the start, after ; & | ( { ! ` or a newline, or after a keyword or a command that runs it. */
const SLEEP = /(?:^|[;&|({!`\n]|\b(?:do|then|else|elif|if|while|until|time|exec|nohup|command|env)\s)\s*(?:\S*\/)?sleep\b/
/**
 * The main Session's guard: it refuses a bash command that runs sleep or asks to hold the step longer than 30 seconds, and a
 * job wait longer than 5 seconds. Under `standard`, as a main Session created before the router preset runs, the shell holds
 * a command 60 seconds and a job wait lasts 30 seconds by default, so a command needs a timeout or the background, and a
 * job wait its timeout; the router preset ends both after 5 seconds.
 */
function noWait({ name, arguments: input }: { name: string; arguments: unknown }, routed: () => boolean): string | undefined {
  const args = (input ?? {}) as { command?: unknown; timeoutMs?: unknown; run_in_background?: unknown; wait?: unknown; timeout_ms?: unknown }
  if (name === SHELL_TOOL) {
    const sleeps = typeof args.command === 'string' && SLEEP.test(args.command)
    if (sleeps || typeof args.timeoutMs === 'number' && args.timeoutMs > 30_000) return NO_WAIT
    if (args.timeoutMs === undefined && args.run_in_background !== true && !routed()) return DEFAULT_WAIT
  }
  if (name === 'job_output' && args.wait === true && (typeof args.timeout_ms === 'number' ? args.timeout_ms > 5_000 : !routed())) return NO_WAIT
  return undefined
}

/**
 * Creates and decorates orchestrator and worker DSH `Agent` sessions with role models, system prompt sections from `Prompts`, runtime skills, and restricted tool sets.
 * `Runtime`, `DshExecutor`, `MasterAssessor`, `Settings`, and management routes/tools use it to ensure sessions, deliver deduplicated messages via `AgentDelivery`, and process ordered `relay` and `notice` effects.
 * Feeds session events into `RetryHealth` to report model budget waits on the `models` `HealthEntry`, and durably records which prompt revisions each session has worked under in `Store` (`KV.sessions.prompts`) to authorize prompt version reads.
 */
export class Sessions {
  private readonly agentDelivery: AgentDelivery
  /** Decorated agents mapped to their registered disposers and skill scope until the agent is disposed or `Sessions.dispose()` runs. */
  private readonly bindings = new Map<Agent, SessionBinding>()
  private readonly retryHealth = new RetryHealth()
  private readonly ctx: Context
  /** Registers ordered `relay` and `notice` effect handlers that deliver to the main Session. */
  constructor(private readonly host: SessionsHost) {
    this.ctx = host.context
    this.agentDelivery = new AgentDelivery(host.context)
    // Deliver relays and notices to the main Session in the order they were queued.
    host.effects.handle('relay', ({ text }, requestId) => this.prompt(host.masterId, requestId, text, 'steer'), { ordered: true })
    host.effects.handle('notice', ({ value, summary }, name) => this.inject(name, value, summary), { ordered: true })
  }
  /** Subscribes to host agent and session events so newly created sessions are decorated and model-budget retries are reflected in health. Call once at startup. */
  install(): void {
    const ctx = this.ctx
    ctx.on('agent/disposed', ({ agent }) => {
      this.release(agent)
      this.retryHealth.clear(agent.id); this.updateModelHealth()
    })
    ctx.on('session/event', (session, event) => {
      const agent = ctx.agents.get(session.id)
      const binding = agent && agent.session === session ? this.bindings.get(agent) : undefined
      if (!agent || !binding || binding.subagent) return
      this.retryHealth.observe(agent.id, event)
      this.updateModelHealth()
    })
    ctx.on('agent/created', async ({ agent }) => { await this.decorate(agent); return undefined })
    // Opening a Session in DSH's Web UI before its first turn may select the default preset for it: select ours again. After
    // its first turn DSH refuses any selection, which leaves it as it is.
    ctx.inject(['agentPresets'], child => {
      child.on('agent-preset/selected', (sessionId, preset) => {
        const ticketId = ticketOfSession(sessionId), agent = ctx.agents.get(sessionId as SessionId)
        const ticket = ticketId ? this.host.store.tickets.get(ticketId) : undefined
        const ours = sessionId === this.host.masterId ? ROUTER_PRESET : ticket ? this.presetOf(ticket) : undefined
        if (!ours || preset === ours || !agent) return
        const presets = child.get('agentPresets') as { select(agent: Agent, preset: string): Promise<string> }
        presets.select(agent, ours).catch(() => {})
      })
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle' && !this.host.closing()) { this.retryHealth.clear(agent.id); this.updateModelHealth() }
    })
  }
  /** Resolves or creates session `id` in workspace `cwd`, initializes its role model, decorates it with prompts/skills/tools, sets the permission preset and agent preset of a new Session (read-only for a read-only ticket's worker), and renames it to `title`. */
  async ensure(id: string, cwd: string, title: string, role: 'orchestrator' | 'worker'): Promise<Agent> {
    const ctx = this.ctx
    const settings = this.host.store.settings()
    const ticket = role === 'worker' ? this.ticketOfId(id) : undefined
    const engine: EngineName = role === 'worker' ? ticket?.execution?.engine ?? settings.executor.engine : 'dsh'
    const readOnly = role === 'worker' && this.readOnlyOf(ticket)
    let result = await ctx.sessionController.resolveAgent(id as SessionId)
    let created = false
    if ('error' in result && result.error.code === 'session/not-found') {
      const workspace = await ctx.workspaceRegistry.create(cwd)
      // A Session keeps the preset it was created with, one of the bundle's own (cordis.patch.yml).
      await ctx.sessionController.create({ sessionId: id as SessionId, workspaceId: workspace.id,
        agentPreset: role === 'worker' ? readOnly ? READONLY_WORKER_PRESET : WORKER_PRESET : ROUTER_PRESET })
      result = await ctx.sessionController.resolveAgent(id as SessionId)
      created = true
    }
    if ('error' in result) throw result.error
    // DSH's Web UI lists only Sessions accounted to a Workspace. A Session created by an earlier
    // run, or by DSH itself, may be missing from that account, which leaves the panel's Open
    // buttons unable to find it; attach is idempotent once the Session is on the account.
    await this.attachWorkspace(result.agent)
    // The ticket's execution snapshots the type's model (or the executor's when the type inherits), so a later settings change does not move it.
    const model = role === 'orchestrator' ? settings.eval.model : ticket?.execution?.model ?? settings.executor.model
    // A native engine runs its own loop; seeding a DSH model would only add an unused selection.
    if (engine === 'dsh') await initializeRoleModel(ctx, result.agent, model)
    await this.decorate(result.agent)
    // Permission overrides are durable in the Session log, so only a new Session needs them; a resumed one replays its own.
    if (created) this.applyPermission(result.agent, readOnly)
    await ctx.sessionController.rename({ sessionId: id as SessionId, title })
    return result.agent
  }
  /**
   * Apply the permissions of a newly created Session: a read-only ticket's worker gets DSH's read-only file sandbox preset,
   * whose approvals are then disabled so an unattended worker fails closed instead of waiting for a person; every other
   * Session keeps full file access. A deployment that defines no read-only preset cannot run a read-only task type, which
   * fails the launch with an error rather than silently running the worker writable.
   */
  private applyPermission(agent: Agent, readOnly: boolean): void {
    const presets = this.ctx.permissionPresets
    if (!readOnly) { presets.set(agent.session, 'danger-full-access'); return }
    if (presets.names?.length && !presets.names.includes(READ_ONLY_PRESET)) {
      throw new Error(`This deployment defines no ${READ_ONLY_PRESET} permission preset, so a read-only task type cannot run`)
    }
    try { presets.set(agent.session, READ_ONLY_PRESET) } catch (error) {
      throw new Error(`A read-only task type needs the ${READ_ONLY_PRESET} permission preset: ${error instanceof Error ? error.message : String(error)}`)
    }
    const approval = this.ctx.get('approval') as ApprovalSeam | undefined
    try { approval?.setPolicy?.(agent, 'never') } catch (error) {
      this.ctx.logger.warn('dsh-superagent could not disable approvals for read-only Session %s: %s', agent.id, String(error))
    }
  }
  /** Account `agent` to the Workspace of its cwd, which the Web UI needs to list and open it; a failure is logged, not fatal. */
  private async attachWorkspace(agent: Agent): Promise<void> {
    const cwd = agent.session.header?.cwd
    if (cwd === undefined) return
    try {
      const workspace = await this.ctx.workspaceRegistry.resolveByPath(cwd) ?? await this.ctx.workspaceRegistry.create(cwd)
      await workspace.attachSession(agent.id)
    } catch (error) {
      this.ctx.logger.warn('dsh-superagent could not attach Session %s to its workspace: %s', agent.id, String(error))
    }
  }
  /** Returns whether `sessionId` already holds the message delivered under `requestId`, or `false` if the session does not exist. */
  async holds(sessionId: string, requestId: string): Promise<boolean> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    return !('error' in result) && await this.agentDelivery.holds(result.agent, key(requestId))
  }
  /** Deliver a message once per request id: to the next turn, the current one, or `inject`ed with its label without waking the agent. */
  async prompt(sessionId: string, requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string }, authorize?: () => void,
    accepted?: () => void): Promise<void> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    if ('error' in result) throw result.error
    await this.agentDelivery.send(result.agent, key(requestId), text, mode, this.host.lifetime, authorize, accepted)
  }
  /** The id of the message `prompt` delivers under `requestId`, which DSH's inbox events name it by. */
  promptedId(requestId: string): MessageId { return messageId(key(requestId)) }
  /** Enqueues a steering relay to the main Session; relays are durable and retried by `Effects` until delivered, at most once per `requestId`. */
  relay(requestId: string, text: string): void { this.host.effects.enqueue('relay', requestId, { text }) }
  /** Enqueues a durable background notice for injection into the main Session; a new notice with the same `name` replaces a still-waiting notice of that `name`. */
  notify(name: string, value: Record<string, unknown>, summary: string): void { this.host.effects.enqueue('notice', name, { value, summary }) }
  /** Waits for currently runnable `notice` effects to settle and returns `'injected'` if notice `name` has reached the main Session or `'pending'` if it is still queued. */
  async delivery(name: string): Promise<'injected' | 'pending'> {
    await this.host.effects.idle('notice')
    return this.host.effects.pending('notice', name) ? 'pending' : 'injected'
  }
  /** Injects a notice into the main Session without waking it; no-op if the main Session does not exist yet. */
  private async inject(name: string, value: Record<string, unknown>, summary: string): Promise<void> {
    const resolved = await this.ctx.sessionController.resolveAgent(this.host.masterId as SessionId)
    if ('error' in resolved) return
    // Deduplicate by notice name and payload hash so retries are idempotent while updated payloads still deliver.
    const text = JSON.stringify(value)
    await this.agentDelivery.send(resolved.agent, `notice:${name}:${key(text)}`, text, { inject: summary }, this.host.lifetime)
  }
  /** Returns the current prompt revision, the active prompt revision of each loaded Session, and whether the main Session still has a pending `'prompts'` notice. */
  status() {
    const { store, prompts, effects } = this.host
    const sessions = store.keys(KV.sessions.prompts).flatMap(name => {
      const sessionId = name.slice(KV.sessions.prompts.prefix.length), revision = store.get(name)?.at(-1)
      return this.ctx.agents.get(sessionId as SessionId) && revision !== undefined ? [{ sessionId, revision }] : []
    })
    return { revision: prompts.current().revision, sessions, notificationPending: effects.pending('notice', 'prompts') }
  }
  /** Returns the prompt version a Session runs under (the one bound on its latest model request, or the current version). */
  promptVersion(sessionId: string): PromptVersion {
    const revision = this.host.store.get(KV.sessions.prompts(sessionId))?.at(-1)
    return revision === undefined ? this.host.prompts.current() : this.host.prompts.version(revision)
  }
  /** Whether a Session is authorized to read `revision` (its active revision or any revision it previously ran under). */
  mayRead(sessionId: string, revision: number): boolean {
    return revision === this.promptVersion(sessionId).revision || (this.host.store.get(KV.sessions.prompts(sessionId)) ?? []).includes(revision)
  }
  /** Returns a tool registrar for `agent` that renders tool output as JSON text and attaches `output.image` as an image when present. */
  private registerTool(agent: Agent, binding: SessionBinding): RegisterTool {
    return (name, description, schema, execute) => {
      binding.disposers.push(agent.ctx.tools.register({ name, description, parameters: z.toJSONSchema(schema),
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => {
          const text = { type: 'text' as const, text: JSON.stringify(value) }
          const image = value && typeof value === 'object' && 'image' in value ? (value as { image: never }).image : undefined
          return image ? [text, { type: 'image' as const, attachment: image }] : [text]
        } },
        execute: (args, execution) => execute(schema.parse(args), execution.signal) }))
    }
  }
  /** Returns `sessionId`'s active model-budget retry state (`{ model_retry }`) for status listings, or `{}` when not waiting on one. */
  modelRetry(sessionId: string | undefined) {
    const retry = sessionId ? this.retryHealth.get(sessionId) : undefined
    return retry ? { model_retry: retry } : {}
  }
  private updateModelHealth(): void {
    const retries = this.retryHealth.list()
    this.host.health.set(retries.length
      ? { state: 'error', detail: retries.slice(0, 5).map(item => `${item.sessionId}: ${item.provider} is over its model budget; retried ${item.attempts} times, waiting since ${item.since}; the model and retry policy are unchanged`).join('; ') + (retries.length > 5 ? `; ${retries.length - 5} more Sessions` : ''), at: retries.at(-1)!.lastAt }
      : { state: 'ready', detail: 'No managed Session is waiting on a model budget retry' })
  }
  private ticketOf(agent: Agent): Ticket | undefined {
    const ticketId = ticketOfSession(agent.id)
    return ticketId === undefined ? undefined : this.host.store.tickets.get(ticketId)
  }
  private ticketOfId(sessionId: string): Ticket | undefined {
    const ticketId = ticketOfSession(sessionId)
    return ticketId === undefined ? undefined : this.host.store.tickets.get(ticketId)
  }
  /** The engine a ticket runs on: the one its acceptance stored, else the executor setting, which also covers tickets accepted before engines existed. */
  private engineOf(ticket: Ticket): EngineName {
    return ticket.execution?.engine ?? this.host.store.settings().executor.engine
  }
  private async decorate(agent: Agent): Promise<void> {
    if (this.bindings.has(agent)) return
    const host = this.host
    const master = agent.id === host.masterId
    const ticket = master ? undefined : this.ticketOf(agent)
    if (!master && !ticket) { this.limitSubagent(agent); return }
    const binding: SessionBinding = { disposers: [] }
    this.bindings.set(agent, binding)
    // The worker prompt a DSH Session reads in its system prompt, and a native engine receives as its system/instruction
    // text: one composition, so task-type instructions, the mandate and the communication policy cannot drift apart.
    const instructionsFor = (bind: boolean): string => {
      const version = this.promptFor(agent, bind)
      const current = ticket && host.store.tickets.get(ticket.id)
      const composed = host.prompts.compose(version.config, master ? 'orchestrator' : 'worker', current ? host.environment(current) : undefined)
      const taskType = current?.execution?.taskType
      // The ticket snapshots its type's instructions, so a later settings edit does not rewrite an in-flight worker.
      const profile = taskType ? host.store.settings().executor.taskTypes.find(type => type.id === taskType) : undefined
      const typeInstructions = taskType ? current?.execution?.instructions ?? profile?.instructions ?? '' : ''
      const taskSection = taskType ? `\n\n## Task type\n${taskType}${profile ? ` (${profile.name})` : ''}${typeInstructions ? `\n${typeInstructions}` : ''}` : ''
      return `[dsh-superagent prompt revision ${version.revision}]\n${composed}\n${current ? mandateInstructions(current.mandate) : ''}${taskSection}`
    }
    // Attach before the asynchronous prompt/skill/tool setup so a prompt that arrives while decoration runs cannot fall
    // through to the DSH model loop. The report tool is looked up when a turn reports, by which time tool setup is done.
    if (!master && ticket && this.engineOf(ticket) === 'claude-code') binding.disposers.push(attachClaudeCode({
      context: this.ctx, agent, ticket, store: this.host.store,
      // The Ticket's snapshotted Claude Code profile, so the driver reads type-level parameters over the global fallbacks.
      settings: () => claudeSettingsForTicket(this.host.store.settings(), ticket), logger: this.ctx.logger, lifetime: this.host.lifetime,
      environment: () => this.host.environment(ticket),
      // The shared execution model and the worker instructions a DSH worker also reads, so both engines see one task text.
      model: () => ticketModel(this.host.store.settings(), ticket), instructions: () => instructionsFor(true),
    }))
    // A native opencode worker runs its own ACP loop; mount it before the asynchronous setup so its step owns the turn.
    if (!master && ticket && this.engineOf(ticket) === 'opencode') binding.disposers.push(attachOpencode({
      context: this.ctx, agent, ticket, store: this.host.store,
      settings: () => opencodeSettingsForTicket(this.host.store.settings(), ticket), logger: this.ctx.logger, lifetime: this.host.lifetime,
      environment: () => this.host.environment(ticket),
      model: () => ticketModel(this.host.store.settings(), ticket), instructions: () => instructionsFor(true),
    }))
    this.retryHealth.restore(agent.id, agent.session.snapshotEvents())
    if (agent.status === 'idle') this.retryHealth.clear(agent.id)
    this.updateModelHealth()
    // Disable variable interpolation so literal ${{ ... }} expressions in team prompts are preserved.
    binding.disposers.push(agent.ctx.systemPrompt.section({ name: 'dsh-superagent-policy', order: 9999, interpolate: false,
      text: context => instructionsFor(context.signal !== undefined), ...(master ? { complete: true } : {}) }))
    // A recreated skill scope (e.g. after the skills service restarts) starts empty, so reset `binding.skills` before rebinding.
    const skillScope = agent.ctx.inject(['skills'], scope => {
      binding.scope = scope
      binding.skills = undefined
      this.bindSkills(binding, host.prompts.current())
    })
    binding.disposers.push(() => { skillScope.dispose().catch((error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release a skill scope: %s', String(error)) }) })
    await skillScope
    // Bail out if the agent was disposed while awaiting the skill scope.
    if (this.bindings.get(agent) !== binding) return
    const register = this.registerTool(agent, binding)
    for (const tool of host.tools(agent, ticket)) register(tool.name, tool.description, tool.schema, tool.execute)
    if (master) {
      binding.disposers.push(agent.ctx.tools.restrict({ allow: ['skill', SHELL_TOOL, 'read', 'read_image', 'job_output', 'job_list', 'job_kill'] }),
        agent.ctx.tools.guard(execution => noWait(execution, () => this.routed(agent))))
    } else {
      // An Executor Session keeps the profile's work tools it has, which DSH requires to be known; its own tools are not masked.
      binding.disposers.push(...this.workOnly(agent, ticket!.id))
    }
  }
  /**
   * Whether a Session runs the router preset: as DSH's preset registry last selected it, read through the session projection
   * on a DSH whose registry has no `presetForSession`, else as it was created; `standard`, the safer caps, when unreadable.
   */
  private routed(agent: Agent): boolean {
    try {
      const presets = this.ctx.get('agentPresets') as { presetForSession?: (session: Agent['session']) => string | null } | undefined
      const projections = this.ctx.get('sessionProjections') as { stateOf?: (session: Agent['session'], key: string) => unknown } | undefined
      const selected = typeof presets?.presetForSession === 'function' ? presets.presetForSession(agent.session)
        : projections?.stateOf?.(agent.session, 'agentPreset')
      return (selected ?? agent.session.header.agentPreset) === ROUTER_PRESET
    } catch { return false }
  }
  /**
   * An Executor Session's tools: only the profile's work tools, which DSH requires to be known, and none once its ticket
   * ended. A failed or blocked worker keeps its tools, so a person may continue it in its Session; only automated input waits
   * (see the executor). Read inherited tools through the parent scope, which includes the preset's tools. The global view
   * misses preset tools; the agent's own view also includes local tools such as subagent, which restrict refuses to name.
   * A read-only Session's BQA MCP tools appear only after the MCP client's asynchronous startup, so its allow mask is
   * recomputed whenever the tool set changes; a mask that named them before they existed would keep hiding them.
   */
  private workOnly(agent: Agent, ticketId: string): (() => void)[] {
    const store = this.host.store
    const parent = scopeParentOf(agent)
    const readOnly = this.readOnlyOf(store.tickets.get(ticketId))
    const guard = agent.ctx.tools.guard(() => {
      const current = store.tickets.get(ticketId)
      return !current || !liveTicket(current) ? 'Ticket ended; new work needs a new authorized ticket' : undefined
    })
    if (!readOnly) return [agent.ctx.tools.restrict({ allow: WORK_TOOLS.filter(name => agent.ctx.tools.get(name, parent)) }), guard]
    let mask: (() => void) | undefined
    let refreshing = false
    const refresh = () => {
      if (refreshing) return
      refreshing = true
      try {
        try { mask?.() } catch { /* Releasing an earlier mask cannot fail in a way the next one depends on. */ }
        mask = agent.ctx.tools.restrict({ allow: READ_ONLY_WORK_TOOLS.filter(name => agent.ctx.tools.get(name, parent)) })
      } catch (error) {
        mask = undefined
        this.ctx.logger.warn('dsh-superagent could not restrict a read-only Session to its retrieval tools: %s', String(error))
      } finally { refreshing = false }
    }
    refresh()
    return [() => { try { mask?.() } catch { /* Already released with the agent. */ } }, guard, agent.ctx.on('tools/change', refresh)]
  }
  /** Whether a ticket's task type runs its worker read-only; the flag is snapshotted onto the ticket at accept time. */
  private readOnlyOf(ticket: Ticket | undefined): boolean { return readOnlyOfTicket(ticket) }
  /** The agent preset a ticket's worker Session runs under: the read-only preset for a read-only task type, else the worker preset. */
  private presetOf(ticket: Ticket): string { return this.readOnlyOf(ticket) ? READONLY_WORKER_PRESET : WORKER_PRESET }
  /**
   * A subagent of an Executor Session, or of one of its subagents, which runs under DSH's `standard` preset with the worker's
   * permissions, gets the same work tools as the worker, and none once the worker's ticket ended. Any other agent is left as
   * it is.
   */
  private limitSubagent(agent: Agent): void {
    let parent = agent.session.header.parentSession
    // Up the subagents' parents to the worker, which are loaded while their subagents run.
    for (let depth = 0; parent !== undefined && ticketOfSession(parent) === undefined && depth < 8; depth++) {
      parent = this.ctx.agents.get(parent)?.session.header.parentSession
    }
    const ticketId = parent === undefined ? undefined : ticketOfSession(parent)
    if (ticketId === undefined || !this.host.store.tickets.get(ticketId)) return
    this.bindings.set(agent, { disposers: this.workOnly(agent, ticketId), subagent: true })
  }
  /** Register the skills of a prompt version in the agent's skill scope, in place of an earlier version's. */
  private bindSkills(binding: SessionBinding, version: PromptVersion): void {
    const { scope, skills: previous } = binding
    if (!scope || previous?.revision === version.revision) return
    previous?.dispose()
    const disposers: (() => void)[] = []
    for (const [name, content] of this.host.prompts.skills(version.config)) {
      const bundled = name === 'feishu' || name === 'github' ? bundledSkills[name] : undefined
      const body = version.config.skills[name] ?? ''
      const description = bundled?.description ?? (body.replace(/\s+/g, ' ').slice(0, 120) || 'Custom dsh-superagent operational skill.')
      disposers.push(scope.skills.register({ name: `${SKILL_PREFIX}${name}`, description, content, source: 'runtime',
        ...(bundled ? { resourceBase: { kind: 'directory' as const, path: dirname(bundled.path) } } : {}) }))
    }
    binding.skills = { revision: version.revision, dispose: () => { disposers.forEach(dispose => dispose()) } }
  }
  /** Return the current prompt version, updating the agent's skills and recording the revision in Store when bound to a model request. */
  private promptFor(agent: Agent, bind: boolean): PromptVersion {
    const version = this.host.prompts.current()
    if (!bind) return version
    const binding = this.bindings.get(agent)
    if (binding) this.bindSkills(binding, version)
    const { store } = this.host
    const revisions = store.get(KV.sessions.prompts(agent.id)) ?? []
    const bound = [...revisions.filter(revision => revision !== version.revision), version.revision]
    if (revisions.at(-1) !== version.revision) store.set(KV.sessions.prompts(agent.id), bound)
    return version
  }
  /** Releases registrations for `agent` in reverse order (LIFO); disposing its skill scope releases its skills as well. */
  private release(agent: Agent): void {
    const binding = this.bindings.get(agent)
    if (!binding) return
    this.bindings.delete(agent)
    binding.skills?.dispose()
    for (const dispose of binding.disposers.splice(0).reverse()) {
      try { dispose() } catch (error) { this.ctx.logger.warn('dsh-superagent could not release what it registered for a Session: %s', String(error)) }
    }
  }
  /** Releases prompt sections, skills, and tools registered by `Sessions` across all decorated agents. */
  dispose(): void { for (const agent of [...this.bindings.keys()]) this.release(agent) }
}
