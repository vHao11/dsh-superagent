/**
 * Native opencode worker bridge: one persistent `opencode acp` process per DSH worker Session, its ACP events projected into
 * the Session log, and permission/elicitation requests routed to DSH's approval and question cards (W2).
 *
 * Phase A froze this module's attachment contract and the KV record a driver keeps; the driver itself lands with W2. Until
 * then `attachOpencode` fails loudly, and `Sessions` refuses to start an opencode worker with the same reason, instead of
 * silently running the DSH model loop under that engine.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process'
import type { Ticket } from '../core/index.ts'
import type { Settings } from '../policy.ts'
import type { Store } from '../app/store.ts'

/** Why selecting the `opencode` engine fails in a build without the W2 driver. */
export const OPENCODE_UNAVAILABLE = 'The opencode engine is not implemented in this build yet (W2): choose dsh or claude-code for the task type, '
  + 'or install a build that includes the opencode ACP driver.'

/** Options used to attach the bridge to one DSH worker agent; the same shape `ClaudeCodeOptions` has, so W2 can share the seam. */
export interface OpencodeOptions {
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

/** Attach the opencode ACP driver to `options.agent`, returning its detach; W2 replaces this stub with the driver. */
export function attachOpencode(_options: OpencodeOptions): () => void {
  throw new Error(OPENCODE_UNAVAILABLE)
}
