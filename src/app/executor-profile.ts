/** The effective execution profile of a task type: its engine, prepare command, blocked commands and engine parameters, resolved over the executor's fallbacks. */
import type { EngineName, Execution, ExecutionClaude, ExecutionOpencode, Ticket } from '../core/index.ts'
import { taskTypeOf, type Settings, type TaskType } from '../policy.ts'

/** The resolved Claude Code parameters of a worker; `bin` is machine-level and always comes from the executor settings. */
export interface ExecutorProfileClaude extends ExecutionClaude { bin: string }
/** The resolved opencode parameters of a worker; empty strings inherit opencode's own configuration. */
export type ExecutorProfileOpencode = ExecutionOpencode
/** The effective execution profile an accepted Ticket snapshots into its `execution`, and whose engine it runs on. */
export interface ExecutorProfile {
  /** The engine when neither the acceptance nor the type overrides it: the task type's, then `executor.engine`. */
  engine: EngineName
  /** The resolved prepare command; '' runs none. Only `per-ticket` directories run it. */
  prepare: string
  /** The commands this type declares; the deployment enforces their union across types (see docs/003). */
  blockedCommands: string[]
  claude: ExecutorProfileClaude
  opencode: ExecutorProfileOpencode
}
/**
 * Resolve the execution profile of `type` over the executor's fallback settings: `engine` (the type's, then the executor's),
 * `prepare` and `blockedCommands` (the type's, then the executor's; `''` and `[]` are explicit values), and each engine
 * parameter (the type's, then the executor's global fallback, then the engine's own default).
 * An explicit engine override is the caller's to apply: it wins over both this profile's engine and the type's.
 */
export function executorProfile(settings: Settings, type: TaskType | undefined): ExecutorProfile {
  const executor = settings.executor
  const claude = type?.claude, opencode = type?.opencode
  return {
    engine: type?.engine ?? executor.engine,
    prepare: type?.prepare ?? executor.prepare,
    blockedCommands: type?.blockedCommands ?? executor.blockedCommands,
    claude: { bin: executor.claudeBin, model: claude?.model ?? executor.claudeModel,
      permissionMode: claude?.permissionMode ?? executor.claudePermissionMode, approval: claude?.approval ?? executor.claudeApproval,
      effort: claude?.effort ?? executor.claudeEffort, ultracode: claude?.ultracode ?? executor.claudeUltracode },
    opencode: { model: opencode?.model ?? executor.opencodeModel, agent: opencode?.agent ?? executor.opencodeAgent,
      approval: opencode?.approval ?? executor.opencodeApproval, permissionPreset: opencode?.permissionPreset ?? executor.opencodePermissionPreset,
      permissionRules: opencode?.permissionRules ?? executor.opencodePermissionRules },
  }
}
/**
 * The executor settings a Claude Code worker reads: the global executor block with the Ticket's snapshotted Claude Code
 * parameters in place of the fallbacks, so the native driver needs no change to read a type's parameters (and a later
 * settings edit does not move an in-flight Ticket).
 */
export function claudeSettingsForTicket(settings: Settings, ticket: Pick<Ticket, 'execution'>): Settings['executor'] {
  const snapshot = ticket.execution?.claude
  const claude = snapshot ? { bin: settings.executor.claudeBin, ...snapshot }
    : executorProfile(settings, taskTypeOf(settings, ticket.execution?.taskType)).claude
  return { ...settings.executor, claudeBin: claude.bin, claudeModel: claude.model, claudePermissionMode: claude.permissionMode,
    claudeApproval: claude.approval, claudeEffort: claude.effort, claudeUltracode: claude.ultracode }
}
/**
 * The executor settings an opencode worker reads: the global executor block with the Ticket's snapshotted opencode
 * parameters in place of the fallbacks, so the native ACP driver reads a type's parameters without a second resolution path,
 * and a later settings edit does not move an in-flight Ticket.
 */
export function opencodeSettingsForTicket(settings: Settings, ticket: Pick<Ticket, 'execution'>): Settings['executor'] {
  const opencode = ticket.execution?.engineOptions?.opencode
    ?? executorProfile(settings, taskTypeOf(settings, ticket.execution?.taskType)).opencode
  return { ...settings.executor, opencodeModel: opencode.model, opencodeAgent: opencode.agent, opencodeApproval: opencode.approval,
    opencodePermissionPreset: opencode.permissionPreset, opencodePermissionRules: opencode.permissionRules }
}
/**
 * The commands the deployment enforces, fail-closed: the executor's list plus every task type's declared list, deduplicated
 * in order. A DSH worker shares the host process's PATH, so a command declared by one type's list fails for every type.
 */
export function deploymentBlockedCommands(settings: Settings): string[] {
  return [...new Set([settings.executor.blockedCommands, ...settings.executor.taskTypes.flatMap(type => type.blockedCommands ?? [])].flat())]
}
/** The blocked commands a Ticket declares to its worker: its acceptance snapshot, or — on older Tickets — its type resolved now. */
export function ticketBlockedCommands(settings: Settings, execution: Execution | undefined): string[] {
  return execution?.blockedCommands ?? executorProfile(settings, taskTypeOf(settings, execution?.taskType)).blockedCommands
}
