import { describe, expect, it, vi } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { githubKind } from '../src/sources/github.ts'

function trigger(source = 'x', meta: Record<string, unknown> = {}): Trigger {
  return {
    id: 't1', source, threads: [{ source, id: 'th1' }], actor: { source, id: 'u1' }, human: true,
    at: new Date().toISOString(), text: 'hi', meta,
  }
}

describe('feishuKind default task type', () => {
  it('parses a chat row with a task type', () => {
    const config = feishuKind.schema.parse({ chats: [{ chatId: 'oc_team', listen: 'mentions', taskType: 'docs' }] })
    expect(config.chats).toHaveLength(1)
    expect(config.chats[0]?.taskType).toBe('docs')
  })

  it('rejects invalid task type ids', () => {
    expect(() => feishuKind.schema.parse({ chats: [{ chatId: 'oc_team', listen: 'mentions', taskType: 'Docs!' }] })).toThrow()
    expect(() => feishuKind.schema.parse({ chats: [{ chatId: 'oc_team', listen: 'mentions', taskType: 'ZRT' }] })).toThrow()
  })

  it('still rejects duplicate chat ids', () => {
    expect(() => feishuKind.schema.parse({ chats: [{ chatId: 'oc_team', listen: 'mentions' }, { chatId: 'oc_team', listen: 'all' }] }))
      .toThrow('Duplicate chat IDs')
  })

  it('defaults a message in a listed chat to its row task type', () => {
    const config = feishuKind.schema.parse({ chats: [{ chatId: 'oc_team', listen: 'mentions', taskType: 'docs' }] })
    expect(feishuKind.taskType!(trigger('feishu', { chatId: 'oc_team', direct: false }), config)).toBe('docs')
  })

  it('leaves direct messages and unlisted chats unclassified', () => {
    const config = feishuKind.schema.parse({ chats: [{ chatId: 'oc_team', listen: 'mentions', taskType: 'docs' }] })
    expect(feishuKind.taskType!(trigger('feishu', { direct: true }), config)).toBeUndefined()
    expect(feishuKind.taskType!(trigger('feishu', { chatId: 'oc_team', direct: true }), config)).toBeUndefined()
    expect(feishuKind.taskType!(trigger('feishu', { chatId: 'oc_other', direct: false }), config)).toBeUndefined()
  })
})

describe('githubKind default task type', () => {
  it('parses the configured task type and returns it for every trigger', () => {
    const config = githubKind.schema.parse({ taskType: 'docs' })
    expect(config.taskType).toBe('docs')
    expect(githubKind.taskType!(trigger('github'), config)).toBe('docs')
  })

  it('leaves triggers unclassified when no task type is configured', () => {
    const config = githubKind.schema.parse({})
    expect(config.taskType).toBeUndefined()
    expect(githubKind.taskType!(trigger('github'), config)).toBeUndefined()
  })

  it('rejects invalid task type ids', () => {
    expect(() => githubKind.schema.parse({ taskType: 'Docs!' })).toThrow()
  })
})

interface FakeSourceOptions {
  taskType?: (trigger: Trigger, config: Record<string, unknown>) => string | undefined
  enabled?: boolean
}

function fakeContext(options: FakeSourceOptions = {}) {
  const received: Trigger[] = []
  const deps = {
    sources: {
      kind: () => options.taskType ? { taskType: options.taskType } : undefined,
      instance: () => ({ id: 'x', kind: 'x', enabled: options.enabled ?? true, config: {} }),
      healthEntries: () => new Map(),
    },
    receive: (receivedTrigger: Trigger) => { received.push(receivedTrigger) },
  } as unknown as SourceContextDeps
  return { context: sourceContextOf(deps, { kind: 'x', health: [] }), received }
}

describe('sourceContextOf task type stamping', () => {
  it('stamps the source default onto a received trigger', () => {
    const { context, received } = fakeContext({ taskType: () => 'docs' })
    context.receive(trigger())
    expect(received).toHaveLength(1)
    expect(received[0]?.taskType).toBe('docs')
  })

  it('never overwrites a task type the trigger already carries', () => {
    const hook = vi.fn(() => 'docs')
    const { context, received } = fakeContext({ taskType: hook })
    context.receive({ ...trigger(), taskType: 'keep' })
    expect(received[0]?.taskType).toBe('keep')
    expect(hook).not.toHaveBeenCalled()
  })

  it('does not stamp while the source instance is disabled', () => {
    const { context, received } = fakeContext({ taskType: () => 'docs', enabled: false })
    context.receive(trigger())
    expect(received).toHaveLength(1)
    expect(received[0]?.taskType).toBeUndefined()
  })

  it('does not stamp when the kind sets no default', () => {
    const { context, received } = fakeContext()
    context.receive(trigger())
    expect(received[0]?.taskType).toBeUndefined()
  })
})
