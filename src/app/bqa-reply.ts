/** Automatic answer callback for tickets the BQA Source accepted: a report becomes the BQA answer or its status. */
import type { ChannelRef, Outbox, Ticket, Trigger, WorkerReport } from '../core/index.ts'
import type { BqaConfig } from '../sources/bqa.ts'
import type { SourceRegistry } from '../sources/registry.ts'

/** Host dependencies of the BQA direct reply. */
export interface BqaReplyHost {
  readonly outbox: Pick<Outbox, 'send'>
  readonly sources: Pick<SourceRegistry, 'instance'>
  /** Reads the Triggers of a ticket's Inputs and of the report's answered question, to find that question's Channel. */
  readonly triggers: { get(id: string): Trigger | undefined }
}
/** The states that are the ticket's result for BQA; progress and waiting reports are not answers. */
const REPORTED = new Set(['ready', 'blocked', 'failed', 'dropped'])
/**
 * The BQA Channel an answer goes to, which carries the `requestId` of the question it answers: the question the report names
 * (`reply_to_trigger_id`), else the newest BQA question among the ticket's Inputs, else the conversation the ticket started in.
 * A reused Ticket holds several questions, so the first one's Channel is only the fallback.
 */
function answerChannel(host: BqaReplyHost, ticket: Ticket, report: WorkerReport): ChannelRef | undefined {
  const answered = report.answers ? host.triggers.get(report.answers)?.channel : undefined
  if (answered?.source === 'bqa') return answered
  const inputs = ticket.inputs ?? []
  for (let index = inputs.length - 1; index >= 0; index--) {
    const input = inputs[index]!
    if (input.kind !== 'trigger' || !input.human) continue
    const channel = host.triggers.get(input.triggerId)?.channel
    if (channel?.source === 'bqa') return channel
  }
  return ticket.channels.find(channel => channel.source === 'bqa')
}
/**
 * Queues a BQA ticket's report for the answer callback: a `ready` report's full summary as the answer, any other result state
 * as its status without answer text, plus the worker Session's token usage and read-only retrieval evidence when the report
 * carries them. The answer goes to the Channel of the question it answers (see `answerChannel`), so each question of a reused
 * Ticket gets its own `requestId`. The message id `bqa-reply:<ticketId>:<report.at>` makes the callback idempotent, and the
 * report's status travels in the Channel address for the channel to send. No-op for every other Source and when direct
 * replies are off.
 */
export function bqaDirectReply(host: BqaReplyHost, ticket: Ticket, report: WorkerReport & { at: string }): void {
  if (!REPORTED.has(report.state)) return
  const origin = answerChannel(host, ticket, report)
  if (!origin) return
  const instance = host.sources.instance<BqaConfig>('bqa')
  if (!instance?.enabled || !instance.config.directReply) return
  host.outbox.send({ id: `bqa-reply:${ticket.id}:${report.at}`, kind: 'reply', ticketId: ticket.id,
    channel: { ...origin, address: { ...origin.address, status: report.state } }, text: report.state === 'ready' ? report.summary : '',
    ...(report.usage ? { usage: report.usage } : {}), ...(report.retrievalCalls?.length ? { retrievalCalls: report.retrievalCalls } : {}) })
}
