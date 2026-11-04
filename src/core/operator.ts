/** The internal Source for work the person operating this installation starts directly in the main Session. */
import type { ActorRef, EngineName, Trigger } from './model.ts'

/**
 * The operator Source. No SourceKind, channel or stored settings produce it: `Engine.startTask` and `Engine.instruct` are
 * its only writers, so its Triggers carry the operator's own request rather than text an external account sent.
 */
export const OPERATOR_SOURCE = 'operator'
export const OPERATOR_ACTOR_ID = 'operator'
export const operatorActor: ActorRef = { source: OPERATOR_SOURCE, id: OPERATOR_ACTOR_ID }

/** A task the operator started in the main Session; `request` is the person's own words. */
export interface OperatorTask {
  title: string
  request: string
  /** The worker engine to use; omitted uses the executor setting. */
  engine?: EngineName
  /** The short English worktree name the accept carries. */
  name?: string
}

/** Whether a Trigger is the operator's own, which only this plugin's main-Session tools create. */
export const isOperatorTrigger = (trigger: Pick<Trigger, 'source' | 'actor' | 'human'>): boolean =>
  trigger.source === OPERATOR_SOURCE && trigger.actor.source === OPERATOR_SOURCE && trigger.actor.id === OPERATOR_ACTOR_ID && trigger.human
