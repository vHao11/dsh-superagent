/** Trigger ingestion, thread correlation, subscription fan-out, and evaluation queuing. */
import { key } from './ids.ts'
import { isoTime, liveTicket, threadKey } from './model.ts'
import type { Ticket, Trigger } from './model.ts'
import { isOperatorTrigger } from './operator.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { Tickets } from './tickets.ts'

export type ReceiveResult = 'stored' | 'duplicate' | 'filtered'

/**
 * Ingests incoming triggers from Sources, deduplicating and filtering them against SourceScope before recording thread correlations.
 * Fans listened triggers out to subscribed tickets via Tickets and queues for Eval, on its primary thread, every trigger no
 * ticket's worker decides (see `followupOwners`).
 * Engine delegates trigger reception to this part.
 */
export class Intake extends EnginePart {
  constructor(options: EngineOptions, private readonly tickets: Tickets) { super(options) }

  receive(received: Trigger): ReceiveResult {
    // Normalize source timestamps (such as GitHub whole seconds) to canonical ISO form.
    const trigger = { ...received, at: isoTime(received.at) }
    if (!trigger.threads.length) throw new Error('A trigger must belong to at least one thread')
    if (this.repo.triggers.get(trigger.id)) return 'duplicate'
    const at = this.now()
    // The operator's own Trigger reaches no Source scope: only this plugin's main-Session tools create it.
    const filter = isOperatorTrigger(trigger) ? { listened: true as const, observed: false } : this.options.scope.scope(trigger)
    if (!filter.listened) {
      this.repo.triggers.save(trigger); this.repo.triggers.saveDisposition(trigger.id, { filtered: { code: filter.reason }, fanout: [], at })
      return 'filtered'
    }
    this.repo.triggers.save(trigger)
    const keys = trigger.threads.map(threadKey)
    // Track reached tickets and whether they were reached only via context threads (a ticket's own thread makes `context` false).
    const reached = new Map<string, { ticket: Ticket; context: boolean }>()
    for (const ref of trigger.threads) {
      const thread = this.thread(ref)
      if (!thread.lastAt || trigger.at > thread.lastAt) thread.lastAt = trigger.at
      thread.correlated = [...new Set([...thread.correlated, ...keys.filter(other => other !== thread.key)])]
      // A `per-message` Source's message is a conversation of its own: it reaches no Ticket of the Thread, not even for context.
      if (trigger.continuity !== 'per-message') {
        for (const ticketId of thread.subscriptions) {
          const ticket = this.repo.tickets.get(ticketId)
          // Only a person's message on a non-context thread resumes an ended ticket; bots and CI do not (the Executor re-reads
          // threads when it resumes), and a human-stopped ticket receives nothing because its Mandate was withdrawn.
          const followed = !!thread.context?.includes(ticketId)
          const resumes = trigger.human && ticket?.ended?.by !== 'human' && !followed
          if (!ticket || (!liveTicket(ticket) && !resumes)) continue
          reached.set(ticketId, { ticket, context: followed && (reached.get(ticketId)?.context ?? true) })
        }
      }
      this.repo.threads.save(thread)
    }
    // A `per-thread` Source continues one conversation per Thread: only one host Ticket receives the message, so historical
    // Tickets on the Thread are never delivered to or woken together.
    const host = trigger.continuity === 'per-thread' ? this.hostOf(reached, trigger) : [...reached.keys()]
    for (const ticketId of host) {
      const { ticket, context: followed } = reached.get(ticketId)!
      this.tickets.addInput(ticket, { id: key('input', ticketId, 'trigger', trigger.id), kind: 'trigger', triggerId: trigger.id, at,
        ...trigger.human ? { human: true } : {}, ...followed ? { context: true } : {} })
    }
    const context = host.filter(id => reached.get(id)!.context)
    const disposition = { fanout: host, ...context.length ? { context } : {}, at }
    this.repo.triggers.saveDisposition(trigger.id, disposition)
    // A person's message that no ticket decides, such as one that reached only tickets a person stopped or that follow the
    // Thread for context, and every bot's, goes to Eval.
    if (!this.owners(trigger).length) this.queueForEval(trigger)
    for (const ticketId of host) this.tickets.wake(ticketId)
    this.emit('trigger.received', { triggerId: trigger.id, threads: trigger.threads.map(threadKey) })
    return 'stored'
  }
  /**
   * The one Ticket a `per-thread` Trigger continues the conversation of: among the Thread's reached Tickets that the Trigger's
   * own actor may work in, the newest by `updatedAt`. A Ticket of another actor is never reused, so a leaked Thread id cannot
   * put one person's message into another person's Ticket; with none, the Trigger starts a new conversation.
   */
  private hostOf(reached: Map<string, { ticket: Ticket; context: boolean }>, trigger: Trigger): string[] {
    const candidates = [...reached].filter(([, { ticket, context }]) => !context && ticket.mandate.actor.id === trigger.actor.id)
    const newest = candidates.sort((a, b) => b[1].ticket.updatedAt.localeCompare(a[1].ticket.updatedAt))[0]
    return newest ? [newest[0]] : []
  }
}
