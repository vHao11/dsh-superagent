/** The per-Source conversation setting: whether each message is its own conversation, or a Thread continues one conversation. */
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import type { FieldSpec } from './kind.ts'

/** `off` keeps every message its own conversation (the pre-setting behavior); `thread` continues one conversation per Thread. */
export const ConversationModeSchema = z.enum(['off', 'thread'])
export type ConversationMode = z.infer<typeof ConversationModeSchema>
/** The mode each built-in kind uses when its configuration omits `conversation`: only BQA changes behavior by choosing `thread`. */
export const CONVERSATION_DEFAULTS: Readonly<Record<string, ConversationMode>> = { bqa: 'off', feishu: 'thread',
  github: 'thread', ume: 'thread', schedule: 'off' }
/** How the core treats the Triggers of a kind in `mode`: one conversation per message, or one per Thread. */
export const continuityOf = (mode: ConversationMode): NonNullable<Trigger['continuity']> =>
  mode === 'thread' ? 'per-thread' : 'per-message'
/**
 * The configuration field every Source kind adds for its `conversation` mode; `mode` is the kind's default, which its schema
 * also defaults to. It states that only newly arriving messages are affected; history and ended Tickets are not merged.
 */
export function conversationField(mode: ConversationMode): FieldSpec {
  return {
    key: 'conversation', type: 'select', label: { zh: '连续会话', en: 'Continuous conversation' },
    options: [
      { value: 'off', label: { zh: '每条消息独立', en: 'Each message separately' } },
      { value: 'thread', label: { zh: '同一会话连续', en: 'One conversation per Thread' } },
    ],
    hint: { zh: `同一会话（线程）里的多次提问复用同一张工单和执行器 Session；默认${mode === 'thread' ? '连续' : '独立'}。`
      + '只影响保存后新到达的消息，已结束的工单不会自动合并。',
    en: `Questions in one Thread reuse one Ticket and its Executor Session; ${mode === 'thread' ? 'continuous' : 'separate'} by default. `
      + 'Only messages arriving after saving are affected; ended Tickets are not merged.' },
  }
}
