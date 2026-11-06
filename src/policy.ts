/**
 * Runtime settings schemas, assessment validation, and policy gate evaluation.
 * Who may originate work is configured per Source in that Source's own identities; the Policy never maps a person across Sources.
 */
import { LIMITS } from './limits.ts'
import { isAbsolute, win32 } from 'node:path'
import { z } from 'zod'
import { ADMISSION_DEFAULTS, ADMISSION_OPTIONS, type Admission, type AdmissionCell, type AdmissionRow } from './admission.ts'
import { ENGINE_NAMES, key, isOperatorTrigger, OPERATOR_SOURCE, UserError, type AssessmentOutcome, type Mandate, type Policy, type PolicyEffect, type SourceScope, type Strength, type Thread, type Ticket,
  type Trigger, type ActorRef, type GateResult } from './core/index.ts'
import { sameName } from './infra/text.ts'
import { WORKER_COMMANDS } from './infra/environment.ts'

export const RuleIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)
export const RuleMatchSchema = z.object({ rule_id: RuleIdSchema, reason: z.string().trim().min(1).max(500) }).strict()
export type RuleMatch = z.infer<typeof RuleMatchSchema>
export const RuleAssessmentSchema = RuleMatchSchema.extend({ matched: z.boolean() }).strict()
export type RuleAssessment = z.infer<typeof RuleAssessmentSchema>
export const AdmissionDirectionSchema = z.object({
  implementation_requested: z.boolean(),
  target_basis: z.enum(['specified', 'existing-standard', 'undetermined']),
  requires_design_decision: z.boolean(),
  evidence: z.string().trim().min(1).max(700),
}).strict()
export type AdmissionDirection = z.infer<typeof AdmissionDirectionSchema>
/** Check whether an assessment established implementation intent and a settled target without open design decisions. */
export function directionAllowed(value: unknown): value is AdmissionDirection {
  const result = AdmissionDirectionSchema.safeParse(value)
  return result.success && result.data.implementation_requested && result.data.target_basis !== 'undetermined' && !result.data.requires_design_decision
}
export interface Assessment {
  decision: 'accept' | 'ignore' | 'unavailable'; rule_assessments: RuleAssessment[]; direction: unknown
  title: string; scope: string; reason: string; intent_evidence?: string | null; acknowledgement?: string | null; worktree_name?: string
  /** The user-defined task type the assessment chose; required for acceptance when task types are configured and the Trigger's Source sets no default. */
  taskType?: string
}
/**
 * Validate an assessment against enabled rules and convert it into an engine `AssessmentOutcome`.
 * Acceptance requires a settled direction, at least one matched enabled rule, and `intent_evidence`, and accepts an
 * inferred candidate only in `auto` mode (otherwise recording it as `would_accept`).
 * @throws when `rule_assessments` does not cover every enabled rule exactly once, an accept omits `intent_evidence`, or an
 * accept cannot be classified while task types are configured.
 */
export function assessmentOutcome(assessment: Assessment, settings: Pick<Settings, 'policy' | 'eval' | 'executor'>, strength: Strength,
  sourceTaskType?: string): AssessmentOutcome {
  const enabled = settings.policy.rules.filter(rule => rule.enabled)
  const judged = assessment.rule_assessments
  const ids = new Set(judged.map(item => item.rule_id))
  if (judged.length !== enabled.length || ids.size !== judged.length || enabled.some(rule => !ids.has(rule.id))) {
    throw new Error('Exactly one assessment for every enabled rule is required; disabled, unknown or missing rule IDs are not allowed')
  }
  const matches = judged.filter(item => item.matched).map(({ rule_id, reason }) => ({ rule_id, reason }))
  const evidence = assessment.intent_evidence ? { intent_evidence: assessment.intent_evidence } : {}
  const audit = { matches, rule_assessments: judged, direction: assessment.direction, ...evidence }
  if (assessment.decision !== 'accept') return { kind: assessment.decision, reason: assessment.reason, audit }
  if (!directionAllowed(assessment.direction)) return { kind: 'ignore', audit, reason: { code: 'directionUnsettled' } }
  if (!matches.length) return { kind: 'ignore', audit, reason: { code: 'noRuleMatched' } }
  if (!assessment.intent_evidence) throw new Error('Acceptance requires intent_evidence')
  const { title, scope, worktree_name: name, taskType } = assessment
  if (strength === 'inferred' && settings.eval.mode !== 'auto') {
    const proposal = { title, scope, worktree_name: name, taskType }
    return { kind: 'ignore', audit: { ...audit, would_accept: true, proposal }, reason: { code: 'observed', values: { text: assessment.reason } } }
  }
  const choice = classifyTaskType(settings, { model: taskType, source: sourceTaskType })
  if (choice.source === 'unclassified') throw unclassifiedTaskTypeError(settings, choice.unknown)
  return { kind: 'accept', title, scope, reason: assessment.reason, ...(assessment.acknowledgement ? { acknowledgement: assessment.acknowledgement } : {}),
    rules: matches.map(match => match.rule_id), audit, ...(name ? { name } : {}),
    ...(choice.source === 'legacy' ? {} : { taskType: choice.type.id, taskTypeSource: choice.source }) }
}
const DEFAULT_RULES = [
  { id: 'copy', name: 'Copy fixes', enabled: true, instruction: 'Explicit requests to correct a typo, wording, punctuation or existing translation. Preserve product promises and business meaning.' },
  { id: 'visual', name: 'Visual fixes', enabled: true, instruction: 'Explicit implementation requests for local spacing, alignment, overflow or styling, with a specified target or an objectively established existing standard/correct state to restore. Locating an element or calling it inconsistent, unattractive or hard to understand does not establish a target. Do not invent visual style, information hierarchy, rendering or interaction decisions. No redesign, new interaction or behavior. A known spacing defect does not authorize adjacent undefined restyling; assess only a clearly separable authorized scope. If direction or scope is unsettled, observe only: no acknowledgement, worker or unsolicited question.' },
]
/** An assessment rule; its instruction may also specify PR reviewers and whether to wait for their approval. */
export const RuleSchema = z.object({ id: RuleIdSchema, name: z.string().trim().min(1).max(LIMITS.ruleName), enabled: z.boolean(),
  instruction: z.string().trim().min(1).max(LIMITS.ruleInstruction) }).strict()
export type Rule = z.infer<typeof RuleSchema>
export const RoleModelSchema = z.object({ provider: z.string().trim().min(1), model: z.string().trim().min(1), reasoningEffort: z.string().trim().min(1).optional() }).strict()
export type RoleModel = z.infer<typeof RoleModelSchema>

/** Check an absolute path on either the running platform or Windows, so a saved Windows deployment stays readable elsewhere. */
const absolutePath = (path: string): boolean => isAbsolute(path) || win32.isAbsolute(path)
/** One ordered opencode permission rule: later rules win, and no match asks a person. */
export const PermissionRuleSchema = z.object({ action: z.string().trim().min(1).max(64),
  resource: z.string().max(4000).default(''), effect: z.enum(['allow', 'deny', 'ask']) }).strict()
/** How the bridge answers an opencode permission request; `smart` allows read-only calls and asks a person for anything that writes, executes or leaves the workspace. */
export const OpencodeApprovalSchema = z.enum(['ask', 'approve', 'deny', 'smart'])
/** The opencode permission preset a worker starts from; Phase 1 applies it to opencode's own global configuration. */
export const OpencodePermissionPresetSchema = z.enum(['smart', 'safe', 'read-only', 'full', 'custom'])
/** The Claude Code parameters a task type can set; each null field inherits the executor's fallback, and the whole object is null when the type sets none. */
export const TaskTypeClaudeSchema = z.object({
  model: z.string().trim().max(200).nullable().default(null),
  permissionMode: z.enum(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']).nullable().default(null),
  approval: z.enum(['ask', 'approve', 'deny']).nullable().default(null),
  effort: z.enum(['', 'low', 'medium', 'high', 'xhigh', 'max']).nullable().default(null),
  ultracode: z.boolean().nullable().default(null),
}).strict()
/** The opencode parameters a task type can set (Phase 1: model, agent, approval and the global permission preset); each null inherits the executor's fallback. */
export const TaskTypeOpencodeSchema = z.object({
  model: z.string().trim().max(200).nullable().default(null),
  agent: z.string().trim().max(64).nullable().default(null),
  approval: OpencodeApprovalSchema.nullable().default(null),
  permissionPreset: OpencodePermissionPresetSchema.nullable().default(null),
  permissionRules: z.array(PermissionRuleSchema).max(64).nullable().default(null),
}).strict()
export const TaskTypeIdSchema = z.string().trim().regex(/^[a-z][a-z0-9-]{0,63}$/, 'Use lowercase letters, digits and dashes, starting with a letter')
/** A command name a person can block; the shims and the worker's own commands cannot be blocked. */
const CommandNameSchema = z.string().regex(/^[A-Za-z0-9._-]+$/).refine(name => name !== '.' && name !== '..', 'Not a command name')
  .refine(name => !WORKER_COMMANDS.includes(name), `${WORKER_COMMANDS.join(', ')} cannot be blocked`)
/** One user-defined task type and the worker profile its tickets run with. */
export const TaskTypeSchema = z.object({
  id: TaskTypeIdSchema,
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(1000),
  examples: z.array(z.string().trim().min(1).max(300)).max(8).default([]),
  not: z.array(z.string().trim().min(1).max(300)).max(8).default([]),
  /** The directory every Ticket of this type works in; `fixed` uses it as is, `per-ticket` appends the Ticket's short name. */
  directory: z.string().trim().min(1).refine(absolutePath, 'An absolute path').describe('Absolute worker directory for this task type.'),
  /** Empty inherits `executor.model` when a Ticket is accepted. */
  model: RoleModelSchema.nullable().default(null),
  directoryMode: z.enum(['per-ticket', 'fixed']).default('fixed'),
  /** Appended to the worker system prompt for this type; optional. */
  instructions: z.string().max(4000).default(''),
  /**
   * Runs this type's workers read-only: the file write/edit tools are withheld, the Session gets the deployment's read-only
   * file sandbox preset, and approvals are disabled so an unattended worker cannot be granted a write.
   */
  readOnly: z.boolean().default(false),
  /** Reserved for per-type concurrency; not enforced yet. */
  maxConcurrent: z.number().int().min(1).max(LIMITS.maxWorkers.max).optional(),
  /** The worker engine of this type's Tickets; null inherits `executor.engine`. */
  engine: z.enum(ENGINE_NAMES).nullable().default(null),
  /** The Claude Code profile of this type; null, or a null field, inherits the executor's fallback. */
  claude: TaskTypeClaudeSchema.nullable().default(null),
  /** The opencode profile of this type (W2); null, or a null field, inherits the executor's fallback and opencode's own configuration. */
  opencode: TaskTypeOpencodeSchema.nullable().default(null),
  /** The prepare command of this type; null inherits `executor.prepare`, and '' runs none. Only `per-ticket` types run it. */
  prepare: z.string().max(LIMITS.prepareCommand).nullable().default(null),
  /** The blocked commands this type declares; null inherits `executor.blockedCommands`, and [] declares none (see docs/003). */
  blockedCommands: z.array(CommandNameSchema).nullable().default(null),
}).strict()
export type TaskType = z.infer<typeof TaskTypeSchema>
export const AllowedSchema = z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict()
const Weak = z.enum(['inferred', 'ignore'])
export const AdmissionRowSchema: z.ZodType<AdmissionRow> = z.object({ listedUnaddressed: z.enum(ADMISSION_OPTIONS.listedUnaddressed).optional(),
  unlistedAddressed: z.enum(ADMISSION_OPTIONS.unlistedAddressed).optional(), unlistedUnaddressed: Weak.optional() }).strict()
export const AdmissionTableSchema = z.record(z.string(), AdmissionRowSchema)
export const SourcePolicySchema = z.object({ allowed: z.array(AllowedSchema).default([]), admission: AdmissionTableSchema.default({}) }).catchall(z.unknown())
export type SourcePolicy = z.infer<typeof SourcePolicySchema>
export const PolicyConfigSchema = z.object({
  rules: z.array(RuleSchema).refine(rules => new Set(rules.map(rule => rule.id)).size === rules.length, 'Duplicate rule IDs').default(DEFAULT_RULES),
  sources: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), SourcePolicySchema).default({}),
}).strict()
/** Per-Source candidate delivery batching; missing fields take the defaults below, and a missing Source entry keeps immediate delivery. */
export const EvalBatchSchema = z.object({
  windowSeconds: z.number().int().min(0).max(3600).default(0),
  maxBatch: z.number().int().min(1).max(20).default(20),
  maxPerMinute: z.number().int().min(1).max(600).default(60),
  mergeWindowSeconds: z.number().int().min(0).max(300).default(0),
}).strict()
export type EvalBatch = z.infer<typeof EvalBatchSchema>
export const EvalConfigSchema = z.object({
  mode: z.enum(['off', 'observe', 'auto']).default('observe'),
  timeoutSeconds: z.number().int().min(LIMITS.evalTimeoutSeconds.min).max(LIMITS.evalTimeoutSeconds.max).default(120),
  model: RoleModelSchema.nullable().default(null),
  /** Candidate delivery batching by Source ID; absent = every candidate is delivered immediately (the pre-batching behavior). */
  batches: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), EvalBatchSchema).default({}),
}).strict()
/** The batch settings of `source`, or undefined when it delivers each candidate immediately. */
export const evalBatch = (settings: Pick<Settings, 'eval'>, source: string): EvalBatch | undefined => settings.eval.batches[source]
/** Claude Code permission modes, as the CLI names them: `default` is Manual, `acceptEdits` is Edit automatically. */
export const ClaudePermissionModeSchema = z.enum(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'])
/** How the bridge answers a Claude Code tool call the permission mode routes to it: ask a person, allow it, or refuse it. */
export const ClaudeApprovalSchema = z.enum(['ask', 'approve', 'deny'])
/** Reasoning effort passed as `--effort`; empty keeps the CLI's own level for the model. */
export const ClaudeEffortSchema = z.enum(['', 'low', 'medium', 'high', 'xhigh', 'max'])
/** Executor settings: worker engine and model, concurrency, ticket directory root and mode, `prepare` command, blocked commands, the native Claude Code executable and its defaults, and the opencode fallbacks the panel hides. */
export const ExecutorConfigSchema = z.object({
  engine: z.enum(ENGINE_NAMES).default('dsh'),
  model: RoleModelSchema.nullable().default(null),
  maxWorkers: z.number().int().min(LIMITS.maxWorkers.min).max(LIMITS.maxWorkers.max).default(3),
  directory: z.string().trim().refine(path => path === '' || isAbsolute(path), 'An absolute path, or empty for <stateDir>/work').default(''),
  /** `per-ticket` gives each Ticket a directory named after its short name under the root; `fixed` runs every Ticket in the root itself and skips the prepare command. */
  directoryMode: z.enum(['per-ticket', 'fixed']).default('per-ticket'),
  prepare: z.string().max(LIMITS.prepareCommand).default(''),
  blockedCommands: z.array(CommandNameSchema).default([]),
  /** The `claude` executable; empty resolves `CLAUDE_CODE_BIN`, the per-user install, then PATH. */
  claudeBin: z.string().trim().default(''),
  /** The opencode executable; empty resolves `OPENCODE_BIN`, the Windows npm global install, then PATH. */
  opencodeBin: z.string().trim().default(''),
  /** The Claude Code model id; empty keeps the CLI's own selection. */
  claudeModel: z.string().trim().max(200).default(''),
  /** The mode Claude Code starts in; `auto` reviews actions with its classifier, `bypassPermissions` skips its checks. */
  claudePermissionMode: ClaudePermissionModeSchema.default('auto'),
  /** How a tool call the mode still routes to the bridge is answered; `approve` keeps Tickets unattended. */
  claudeApproval: ClaudeApprovalSchema.default('approve'),
  /** Reasoning effort for new Claude Code processes; empty keeps the CLI's level. */
  claudeEffort: ClaudeEffortSchema.default(''),
  /** Turn on Claude Code's dynamic workflows; passed as `{"ultracode":true}` in `--settings`. */
  claudeUltracode: z.boolean().default(false),
  /** opencode fallbacks, API-only (the panel hides them in favor of the task type): the model and agent a type inherits, and the approval preset. */
  opencodeModel: z.string().trim().max(200).default(''),
  opencodeAgent: z.string().trim().max(64).default(''),
  opencodeApproval: OpencodeApprovalSchema.default('smart'),
  opencodePermissionPreset: OpencodePermissionPresetSchema.default('smart'),
  opencodePermissionRules: z.array(PermissionRuleSchema).max(64).default([]),
  /** User-defined task types; each binds a Ticket's directory, model, mode, worker instructions and execution profile. Empty keeps the legacy single-directory executor. */
  taskTypes: z.array(TaskTypeSchema).max(24).default([]),
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>()
  value.taskTypes.forEach((type, index) => {
    if (ids.has(type.id)) ctx.addIssue({ code: 'custom', message: `Duplicate task type id: ${type.id}`, path: ['taskTypes', index, 'id'] })
    ids.add(type.id)
  })
})
export const SourceInstanceSchema = z.object({ enabled: z.boolean().default(true), config: z.record(z.string(), z.unknown()).default({}) }).strict()
export const SettingsSchema = z.object({
  paused: z.boolean().default(false),
  sources: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), SourceInstanceSchema).default({}),
  policy: PolicyConfigSchema.default(() => PolicyConfigSchema.parse({})),
  eval: EvalConfigSchema.default(() => EvalConfigSchema.parse({})),
  executor: ExecutorConfigSchema.default(() => ExecutorConfigSchema.parse({})),
}).strict()
export type Settings = z.infer<typeof SettingsSchema>
/** How a Ticket's task type was chosen: explicitly by the operator or sorter, a Source's configured default, the assessor's classification, or no task types configured (legacy). */
export type TaskTypeSource = 'explicit' | 'source' | 'model' | 'legacy'
/** The task type chosen for new work, or why there is none: `legacy` when no types are configured, `unclassified` when the work named none or named an unknown one. */
export type TaskTypeChoice =
  | { type: TaskType; source: Exclude<TaskTypeSource, 'legacy'> }
  | { source: 'legacy' }
  | { source: 'unclassified'; unknown?: string }
/**
 * Choose the task type of new work from the evidence its entry point holds, strongest first: the operator's or sorter's
 * explicit id, the Source's configured default on the Trigger, then the assessor's classification. With task types
 * configured there is no default: work that names none, or names one that does not exist, stays unclassified and its caller
 * refuses it (see `unclassifiedTaskTypeError`).
 */
export function classifyTaskType(settings: Pick<Settings, 'executor'>,
  evidence: { explicit?: string | null; source?: string | null; model?: string | null }): TaskTypeChoice {
  const types = settings.executor.taskTypes
  if (!types.length) return { source: 'legacy' }
  const exact = (id: string | null | undefined) => {
    const wanted = id?.trim()
    return wanted ? types.find(type => type.id === wanted) : undefined
  }
  const explicit = evidence.explicit?.trim()
  if (explicit) {
    const found = exact(explicit)
    // An explicit id that does not exist is the operator's or sorter's mistake, not an invitation to guess another type.
    return found ? { type: found, source: 'explicit' } : { source: 'unclassified', unknown: explicit }
  }
  const source = exact(evidence.source)
  if (source) return { type: source, source: 'source' }
  const model = evidence.model?.trim()
  if (model) {
    const found = exact(model)
    // The assessor named an id: report it back when it does not exist so the next decision can correct it.
    return found ? { type: found, source: 'model' } : { source: 'unclassified', unknown: model }
  }
  return { source: 'unclassified' }
}
/** The refusal for work that cannot be classified; `unknown` names the id that does not exist. */
export function unclassifiedTaskTypeError(settings: Pick<Settings, 'executor'>, unknown?: string): UserError {
  const types = settings.executor.taskTypes.map(type => type.id).join(', ')
  return unknown ? new UserError('unknownTaskType', { type: unknown, types }) : new UserError('unclassifiedWork', { types })
}
/** Look up a configured task type by id; undefined for a removed or unknown type. */
export const taskTypeOf = (settings: Pick<Settings, 'executor'>, id: string | null | undefined): TaskType | undefined =>
  id ? settings.executor.taskTypes.find(type => type.id === id) : undefined
export type SettingsBlock = 'policy' | 'eval' | 'executor' | `source:${string}`
export type SettingsSave = SettingsBlock | 'pause'
export type SettingsOrigin = 'panel' | 'tool' | 'sync'

export const POLICY_REVISION = 'mandate-v3'
/**
 * Compute a version hash for settings that affect work authorization.
 * Changes to models, concurrency, pause state, or polling intervals do not invalidate existing decisions.
 */
export function policyVersion(settings: Settings): string {
  return key(POLICY_REVISION, JSON.stringify({ rules: settings.policy.rules, mode: settings.eval.mode, sources: settings.policy.sources }))
}
export function allowedSender(settings: Settings, actor: ActorRef): z.infer<typeof AllowedSchema> | undefined {
  return settings.policy.sources[actor.source]?.allowed.find(entry => sameName(entry.id, actor.id))
}
/** Look up `actor` in the Source's `bots` policy list (validated by the Source's kind), whose messages are admitted as inferred candidates at most. */
export function listedBot(settings: Settings, actor: ActorRef): z.infer<typeof AllowedSchema> | undefined {
  const bots = z.array(AllowedSchema).catch([]).parse(settings.policy.sources[actor.source]?.bots ?? [])
  return bots.find(entry => sameName(entry.id, actor.id))
}
export const anyoneAllowed = (settings: Settings): boolean => Object.values(settings.policy.sources).some(part => part.allowed.length > 0)
const senderName = (entry: z.infer<typeof AllowedSchema>): string => entry.name || entry.id

/** Check whether a thread has tickets of its own (excluding context-only subscriptions). */
const participating = (thread: Thread, tickets: Ticket[]): boolean =>
  [...thread.subscriptions, ...tickets.map(ticket => ticket.id)].some(id => !thread.context?.includes(id))
const listened = (sources: SourceScope, source: string, meta: Record<string, unknown>) => sources.scope({ source, meta })

function admissionCell(allowed: boolean, addressed: boolean): AdmissionCell | undefined {
  return allowed ? addressed ? undefined : 'listedUnaddressed' : addressed ? 'unlistedAddressed' : 'unlistedUnaddressed'
}
function admissionOf(settings: Settings, source: string, row: string | undefined, cell: AdmissionCell): Admission {
  return (row === undefined ? undefined : settings.policy.sources[source]?.admission[row]?.[cell]) ?? ADMISSION_DEFAULTS[cell]
}
const STRENGTH: Readonly<Record<Admission, number>> = { ignore: 0, inferred: 1, explicit: 2 }

/** Compute how a settings change from `old` to `now` affects the authorization or matched rules of each open ticket. */
export function policyEffects(tickets: readonly Ticket[], old: Settings, now: Settings, scope: (settings: Settings) => SourceScope):
  Map<string, PolicyEffect> {
  const before = settingsPolicy(old, scope(old)), after = settingsPolicy(now, scope(now))
  const effects = new Map<string, PolicyEffect>()
  for (const ticket of tickets) {
    const rules = (ticket.mandate.basis.rules ?? []).flatMap((id): NonNullable<PolicyEffect['rules']> => {
      const was = old.policy.rules.find(rule => rule.id === id), is = now.policy.rules.find(rule => rule.id === id)
      if (!is?.enabled) return was?.enabled ? [{ id, name: was.name, change: 'disabled' }] : []
      return JSON.stringify(was) === JSON.stringify(is) ? [] : [{ id, name: is.name, change: 'changed', instruction: is.instruction }]
    })
    const effect: PolicyEffect = rules.length ? { rules } : {}
    if (before.revalidate(ticket.mandate) && !after.revalidate(ticket.mandate)) {
      // With the previous accept mode and rules, the Mandate holds unless the sender or receiving scope lost authorization.
      const asBefore = { ...now, eval: old.eval, policy: { ...now.policy, rules: old.policy.rules } }
      if (!settingsPolicy(asBefore, scope(now)).revalidate(ticket.mandate)) {
        Object.assign(effect, { requesterAllowed: false, requester: ticket.mandate.actor })
      } else if (ticket.mandate.strength === 'inferred' && old.eval.mode === 'auto' && now.eval.mode !== 'auto') effect.proactive = false
    }
    if (Object.keys(effect).length) effects.set(ticket.id, effect)
  }
  return effects
}
/** Build the active Policy for gating incoming Triggers and revalidating existing Ticket Mandates. */
export function settingsPolicy(settings: Settings, sources: SourceScope): Policy {
  const version = policyVersion(settings)
  const mode = settings.eval.mode
  /** Gate non-human triggers: only listed bots (as inferred candidates) and senderless system/CI events may pass; other bots are rejected. */
  const machineGate = (trigger: Trigger): GateResult => {
    const bot = trigger.actor.id ? listedBot(settings, trigger.actor) : undefined
    if (trigger.actor.id && !bot) return { admissible: false, reason: 'not_human' }
    const scope = listened(sources, trigger.source, trigger.meta)
    if (!scope.listened || !(trigger.addressed || scope.observed)) return { admissible: false, reason: 'not_human' }
    const recorded = { source: trigger.source, scope: trigger.meta, ...scope.row === undefined ? {} : { row: scope.row } }
    const addressed = trigger.addressed ? { addressed: trigger.addressed } : {}
    if (bot) {
      if (mode === 'off') return { admissible: false, reason: 'admission_ignored' }
      const basis = { ...recorded, via: 'bot' as const, sender: senderName(bot), ...addressed, observation: { mode } }
      return { admissible: true, strength: 'inferred', basis }
    }
    const cell = 'unlistedUnaddressed' as const
    if (admissionOf(settings, trigger.source, scope.row, cell) !== 'inferred' || mode === 'off') {
      return { admissible: false, reason: 'admission_ignored' }
    }
    return { admissible: true, strength: 'inferred', basis: { ...recorded, via: 'admission', cell, observation: { mode } } }
  }
  return {
    version, paused: settings.paused, evalTimeoutMs: settings.eval.timeoutSeconds * 1000,
    mergeWindowMs: source => (settings.eval.batches[source]?.mergeWindowSeconds ?? 0) * 1000,
    gate(trigger: Trigger, thread, tickets) {
      // The operator writes in the main Session, whose tool alone creates this Trigger; no Source list or scope applies.
      if (isOperatorTrigger(trigger)) return { admissible: true, strength: 'explicit',
        basis: { source: OPERATOR_SOURCE, via: 'addressed', addressed: trigger.addressed ?? 'direct' } }
      if (!trigger.human) return machineGate(trigger)
      const allowed = allowedSender(settings, trigger.actor)
      const scope = listened(sources, trigger.source, trigger.meta)
      const row = scope.listened ? scope.row : undefined
      const recorded = { source: trigger.source, scope: trigger.meta, ...row === undefined ? {} : { row }, ...allowed ? { sender: senderName(allowed) } : {} }
      if (allowed && trigger.addressed) return { admissible: true, strength: 'explicit', basis: { ...recorded, via: 'addressed', addressed: trigger.addressed } }
      const cell = admissionCell(!!allowed, !!trigger.addressed)!
      // Unaddressed messages only use the admission table when the Source observes all messages in that scope.
      const receivable = !!trigger.addressed || (scope.listened && scope.observed)
      const admission = receivable ? admissionOf(settings, trigger.source, row, cell) : 'ignore'
      const basis = { ...recorded, via: 'admission' as const, cell, ...trigger.addressed ? { addressed: trigger.addressed } : {} }
      // Check explicit admission cells before thread follow-ups so a thread's tickets never weaken an explicit request to a follow-up.
      if (admission === 'explicit') return { admissible: true, strength: 'explicit', basis }
      // Direct-message threads belong to one sender (no follow-up for others), and inferred follow-ups require an accept mode other than off (when off, the table decides).
      if (!(trigger.addressed === 'direct' && !allowed) && (allowed || mode !== 'off') && participating(thread, tickets)) {
        return { admissible: true, strength: allowed ? 'explicit' : 'inferred', basis: { ...recorded, via: 'followup' } }
      }
      if (admission === 'inferred' && mode !== 'off') return { admissible: true, strength: 'inferred', basis: { ...basis, observation: { mode } } }
      return { admissible: false, reason: !allowed ? 'not_a_member' : receivable && admission === 'ignore' ? 'admission_ignored' : 'no_mention' }
    },
    admitsInferred: rules => mode === 'auto' && rules.length > 0 && rules.every(id => settings.policy.rules.some(rule => rule.enabled && rule.id === id)),
    revalidate(mandate: Mandate) {
      // Revalidation rules follow docs/002 (Eval path; Resume revalidates).
      const { basis } = mandate
      // The operator's Mandate comes from the local main Session, which keeps its authority without a Source list.
      if (basis.source === OPERATOR_SOURCE && basis.via === 'addressed') return mandate.strength === 'explicit'
      const { source } = basis
      const current = source && basis.scope ? listened(sources, source, basis.scope) : undefined
      if (current && !current.listened) return false
      const rulesOn = (rules: string[] | undefined) => (rules ?? []).every(id => settings.policy.rules.some(rule => rule.enabled && rule.id === id))
      // Explicit follow-ups remain valid; inferred follow-ups require auto mode and enabled matched rules.
      if (basis.via === 'followup') return mandate.strength === 'explicit' || (mode === 'auto' && rulesOn(basis.rules))
      // A bot's candidate holds only while the bot remains on its Source's bot list and passes the observation checks below.
      if (basis.via === 'bot' && !listedBot(settings, mandate.actor)) return false
      // An admission-table Mandate holds while the sender's current cell still grants at least the original strength.
      if (basis.via === 'admission') {
        const { cell } = basis
        const listed = !!allowedSender(settings, mandate.actor)
        // A listed sender who addresses the agent is always explicit and uses no table cell.
        if (cell === 'unlistedAddressed' && listed) return true
        // A sender added to the allowed list since acceptance moves to the listed cell, and still undergoes observation checks below.
        const now = cell === 'unlistedUnaddressed' && listed ? 'listedUnaddressed' : cell
        if (now === 'listedUnaddressed' && !listed) return false
        const admission = admissionOf(settings, source ?? '', current?.listened ? current.row : undefined, now)
        if (STRENGTH[admission] < STRENGTH[mandate.strength]) return false
        if (mandate.strength === 'explicit') return true
      } else if (basis.via !== 'bot' && !allowedSender(settings, mandate.actor)) return false
      // Observed/inferred Mandates hold only while auto mode is active and all matched rules remain enabled.
      if ((basis.via === 'admission' || basis.via === 'listed' || basis.via === 'bot') && basis.observation) return mode === 'auto' && rulesOn(basis.rules)
      return true
    },
  }
}
