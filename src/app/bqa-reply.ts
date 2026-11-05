/** Automatic answer callback for tickets the BQA Source accepted: a report becomes the BQA answer or its status. */
import type { Outbox, Ticket, WorkerReport } from '../core/index.ts'
import type { BqaConfig } from '../sources/bqa.ts'
import type { SourceRegistry } from '../sources/registry.ts'

/** Host dependencies of the BQA direct reply. */
export interface BqaReplyHost {
  readonly outbox: Pick<Outbox, 'send'>
  readonly sources: Pick<SourceRegistry, 'instance'>
}
/** The states that are the ticket's result for BQA; progress and waiting reports are not answers. */
const REPORTED = new Set(['ready', 'blocked', 'failed', 'dropped'])
/**
 * Queues a BQA ticket's report for the answer callback: a `ready` report's full summary as the answer, any other result state
 * as its status without answer text, plus the worker Session's token usage and read-only retrieval evidence when the report
 * carries them. The message id `bqa-reply:<ticketId>:<report.at>` makes the callback idempotent, and the report's status
 * travels in the Channel address for the channel to send. No-op for every other Source and when direct replies are off.
 */
export function bqaDirectReply(host: BqaReplyHost, ticket: Ticket, report: WorkerReport & { at: string }): void {
  if (!REPORTED.has(report.state)) return
  const origin = ticket.channels.find(channel => channel.source === 'bqa')
  if (!origin) return
  const instance = host.sources.instance<BqaConfig>('bqa')
  if (!instance?.enabled || !instance.config.directReply) return
  host.outbox.send({ id: `bqa-reply:${ticket.id}:${report.at}`, kind: 'reply', ticketId: ticket.id,
    channel: { ...origin, address: { ...origin.address, status: report.state } }, text: report.state === 'ready' ? report.summary : '',
    ...(report.usage ? { usage: report.usage } : {}), ...(report.retrievalCalls?.length ? { retrievalCalls: report.retrievalCalls } : {}) })
}
