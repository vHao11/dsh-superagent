/** The effective execution profile of a task type: its engine, prepare command, blocked commands and engine parameters, resolved over the executor's fallbacks. */
import type { EngineName, ExecutionClaude, ExecutionOpencode } from '../core/index.ts'
import type { Settings, TaskType } from '../policy.ts'

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
 */
export function executorProfile(_settings: Settings, _type: TaskType | undefined): ExecutorProfile {
  // Phase A freezes the contract; the resolution lands with W1 (see the execution refactor plan §4.2).
  throw new Error('The executor profile resolver is not implemented in this build yet')
}
