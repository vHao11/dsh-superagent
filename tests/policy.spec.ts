import { describe, expect, it } from 'vitest'
import { SettingsSchema, TaskTypeSchema, assessmentOutcome, classifyTaskType, policyEffects, settingsPolicy, policyVersion, allowedSender,
  anyoneAllowed, unclassifiedTaskTypeError, type Settings } from '../src/policy.ts'
import type { Mandate, MandateBasis } from '../src/core/index.ts'
import { migrateSettings } from '../src/app/migration.ts'
import { deploymentBlockedCommands, executorProfile, opencodeSettingsForTicket, ticketModel } from '../src/app/executor-profile.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { bqaKind } from '../src/sources/bqa.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { githubKind } from '../src/sources/github.ts'
import type { Thread, Ticket, Trigger } from '../src/core/index.ts'

const MEMBER = 'ou_alice'
const CHAT = 'oc_team'
const OBSERVED = 'oc_1111111111111111111111111111'
const feishuSource = (config: { chats: { chatId: string; listen: 'mentions' | 'all' }[]; directMessages: boolean }, enabled = true) => ({ enabled, config })
const base = SettingsSchema.parse({
  policy: { sources: { feishu: { allowed: [{ id: MEMBER, name: 'Alice' }], syncChat: CHAT }, github: { allowed: [{ id: 'Alice' }] } } },
  eval: { mode: 'auto' },
  sources: { feishu: feishuSource({ chats: [{ chatId: CHAT, listen: 'mentions' }, { chatId: OBSERVED, listen: 'all' }], directMessages: true }) },
})
function setup(settings: Settings = base) {
  const sources = new SourceRegistry(() => settings)
  sources.register(feishuKind); sources.register(githubKind)
  return { sources, policy: settingsPolicy(settings, sources), version: policyVersion(settings) }
}
const { sources, policy } = setup()
const thread = (subscriptions: string[] = []): Thread => ({ key: 'feishu:x', ref: { source: 'feishu', id: 'x' }, createdAt: '', subscriptions, correlated: [], pending: [], meta: {} })
const feishu = (overrides: Partial<Trigger> & { meta?: Record<string, unknown> } = {}): Trigger => ({ id: 't', source: 'feishu', threads: [{ source: 'feishu', id: 'x' }], actor: { source: 'feishu', id: MEMBER }, human: true, at: '', text: 'hi', addressed: 'mention', meta: { chatId: CHAT, direct: false, mentioned: true }, ...overrides })
const unaddressed = (overrides: Partial<Trigger> = {}): Trigger => { const { addressed: _addressed, ...rest } = feishu(overrides); return rest }
const github = (login: string, addressed?: 'mention'): Trigger => ({ id: 'g', source: 'github', threads: [{ source: 'github', id: '1' }], actor: { source: 'github', id: login }, human: true, at: '', text: 'x', ...addressed ? { addressed } : {}, meta: { number: 1, isPr: true } })
const ticket = { id: 'ticket', ended: { at: '', by: 'executor', reason: 'closed', outcome: 'closed' } } as Ticket

describe('source scope', () => {
  it('listens to configured chats, reads every message only where configured, and follows the direct-message switch', () => {
    expect(sources.scope(feishu())).toEqual({ listened: true, observed: false, row: CHAT })
    expect(sources.scope(feishu({ meta: { chatId: OBSERVED, direct: false, mentioned: false } }))).toEqual({ listened: true, observed: true, row: OBSERVED })
    expect(sources.scope(feishu({ meta: { chatId: 'oc_other', direct: false, mentioned: true } }))).toEqual({ listened: false, reason: 'chat_not_allowed' })
    expect(sources.scope(feishu({ meta: { chatId: 'p2p', direct: true, mentioned: false } }))).toEqual({ listened: true, observed: false, row: 'direct' })
    expect(setup({ ...base, sources: { feishu: feishuSource({ chats: [], directMessages: false }) } }).sources.scope(feishu({ meta: { chatId: 'p2p', direct: true, mentioned: false } }))).toEqual({ listened: false, reason: 'direct_messages_not_allowed' })
    expect(sources.scope(github('anyone'))).toEqual({ listened: true, observed: false })
  })
  it('listens to nothing from a configured Source whose plugin is not loaded, and keeps an invalid stored configuration disabled', () => {
    const bare = new SourceRegistry(() => base)
    expect(bare.scope(feishu())).toEqual({ listened: false, reason: 'source_not_installed' })
    expect(bare.scope(github('anyone'))).toEqual({ listened: true, observed: false })
    const broken = new SourceRegistry(() => SettingsSchema.parse({ sources: { feishu: { enabled: true, config: { chats: 'oops' } } } }))
    broken.register(feishuKind)
    expect(broken.instance('feishu')).toMatchObject({ enabled: false })
    expect(broken.scope(feishu())).toEqual({ listened: false, reason: 'source_disabled' })
  })
  it('filters everything from a disabled Source', () => {
    expect(setup({ ...base, sources: { ...base.sources, github: { enabled: false, config: {} } } }).sources.scope(github('anyone'))).toEqual({ listened: false, reason: 'source_disabled' })
  })
})
describe('gate', () => {
  it('grants explicit strength when the sender is allowed in its Source\'s part and the Source marked the Trigger addressed', () => {
    expect(policy.gate(feishu(), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { via: 'addressed', source: 'feishu', sender: 'Alice', addressed: 'mention', scope: { chatId: CHAT } } })
    expect(policy.gate(feishu({ addressed: 'direct', meta: { chatId: 'p2p', direct: true, mentioned: false } }), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { addressed: 'direct' } })
    // GitHub logins compare without case; the entry's id names the sender when it has no display name.
    expect(policy.gate(github('alice', 'mention'), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { source: 'github', sender: 'Alice' } })
  })
  it('checks each Source\'s own list: a Feishu id allows nothing on GitHub', () => {
    expect(policy.gate(github(MEMBER, 'mention'), thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
    expect(allowedSender(base, { source: 'github', id: 'ALICE' })).toEqual({ id: 'Alice' })
    expect(allowedSender(base, { source: 'feishu', id: 'Alice' })).toBeUndefined()
    expect(anyoneAllowed(base)).toBe(true)
    expect(anyoneAllowed(SettingsSchema.parse({}))).toBe(false)
  })
  it('assesses follow-ups on Threads with Tickets, explicit from an allowed sender and inferred from anyone else', () => {
    const quiet = { meta: { chatId: CHAT, direct: false, mentioned: false } }
    expect(policy.gate(unaddressed({ ...quiet, actor: { source: 'feishu', id: 'ou_guest' } }), thread(['ticket']), [])).toMatchObject({ admissible: true, strength: 'inferred', basis: { via: 'followup' } })
    expect(policy.gate(unaddressed(quiet), thread(['ticket']), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { via: 'followup', sender: 'Alice' } })
    expect(policy.gate(github('someone'), thread(), [ticket])).toMatchObject({ admissible: true, strength: 'inferred' })
    // A Thread a ticket follows only for context lends no follow-up: the admission table decides, as on any Thread.
    const context = { ...thread(['ticket']), context: ['ticket'] }
    expect(policy.gate(unaddressed(quiet), context, [ticket])).toMatchObject({ admissible: false })
  })
  it('infers strength for allowed senders\' messages the Source observes, unless Eval is off', () => {
    const observed = unaddressed({ meta: { chatId: OBSERVED, direct: false, mentioned: false } })
    expect(policy.gate(observed, thread(), [])).toMatchObject({ admissible: true, strength: 'inferred', basis: { via: 'admission', observation: { mode: 'auto' } } })
    expect(setup({ ...base, eval: { ...base.eval, mode: 'off' } }).policy.gate(observed, thread(), [])).toEqual({ admissible: false, reason: 'no_mention' })
  })
  it('admits no direct message from a sender the Source\'s part does not allow, not even as a follow-up', () => {
    expect(policy.gate(feishu({ actor: { source: 'feishu', id: 'ou_guest' }, addressed: 'direct', meta: { chatId: 'p2p', direct: true, mentioned: false } }), thread(['ticket']), [])).toEqual({ admissible: false, reason: 'not_a_member' })
  })
  it('rejects automated messages, unknown senders without a Thread, and allowed senders who did not address the agent', () => {
    expect(policy.gate(feishu({ human: false }), thread(), [])).toEqual({ admissible: false, reason: 'not_human' })
    expect(policy.gate(feishu({ actor: { source: 'feishu', id: 'ou_guest' } }), thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
    expect(policy.gate(unaddressed({ meta: { chatId: CHAT, direct: false, mentioned: false } }), thread(), [])).toEqual({ admissible: false, reason: 'no_mention' })
  })
})
describe('admission table', () => {
  const STRANGER = 'ou_stranger'
  const withTable = (admission: Record<string, Record<string, string>>, config: Record<string, unknown> = {}, mode: 'off' | 'observe' | 'auto' = 'auto') => SettingsSchema.parse({ ...base,
    eval: { ...base.eval, mode },
    sources: { ...base.sources, feishu: { enabled: true, config: { ...base.sources.feishu!.config, ...config } } },
    policy: { ...base.policy, sources: { ...base.policy.sources, feishu: { ...base.policy.sources.feishu!, admission } } } })
  const inChat = (chatId: string, sender = MEMBER, addressed = true): Trigger => {
    const message = feishu({ actor: { source: 'feishu', id: sender }, meta: { chatId, direct: false, mentioned: addressed } })
    if (addressed) return message
    const { addressed: _addressed, ...rest } = message
    return rest
  }
  it('reproduces the behaviour before the table with every cell unset', () => {
    expect(policy.gate(inChat(OBSERVED, MEMBER, false), thread(), [])).toMatchObject({ admissible: true, strength: 'inferred', basis: { via: 'admission', row: OBSERVED, cell: 'listedUnaddressed', observation: { mode: 'auto' } } })
    expect(policy.gate(inChat(CHAT, STRANGER), thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
    expect(policy.gate(feishu({ actor: { source: 'feishu', id: STRANGER }, addressed: 'direct', meta: { chatId: 'p2p', direct: true, mentioned: false } }), thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
    // A listed sender who addresses the agent makes an explicit request whatever the table says.
    expect(setup(withTable({ [CHAT]: { unlistedAddressed: 'ignore' } })).policy.gate(inChat(CHAT), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit' })
  })
  it('makes an unlisted sender\'s mention explicit or inferred as the row says, and an inferred one waits for a mode that assesses', () => {
    const explicit = setup(withTable({ [CHAT]: { unlistedAddressed: 'explicit' } })).policy.gate(inChat(CHAT, STRANGER), thread(), [])
    expect(explicit).toEqual({ admissible: true, strength: 'explicit', basis: { source: 'feishu', scope: { chatId: CHAT, direct: false, mentioned: true }, row: CHAT, via: 'admission', cell: 'unlistedAddressed', addressed: 'mention' } })
    expect(setup(withTable({ [CHAT]: { unlistedAddressed: 'inferred' } })).policy.gate(inChat(CHAT, STRANGER), thread(), [])).toMatchObject({ admissible: true, strength: 'inferred', basis: { cell: 'unlistedAddressed' } })
    expect(setup(withTable({ [CHAT]: { unlistedAddressed: 'inferred' } }, {}, 'off')).policy.gate(inChat(CHAT, STRANGER), thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
    expect(setup(withTable({ direct: { unlistedAddressed: 'explicit' } })).policy.gate(feishu({ actor: { source: 'feishu', id: STRANGER }, addressed: 'direct', meta: { chatId: 'p2p', direct: true, mentioned: false } }), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { row: 'direct', cell: 'unlistedAddressed' } })
    expect(setup(withTable({ [OBSERVED]: { unlistedAddressed: 'explicit' } })).policy.gate(inChat(CHAT, STRANGER), thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
  })
  it('ignores a listed sender\'s unaddressed message where the row says so, and never reads the table for messages the chat does not receive', () => {
    expect(setup(withTable({ [OBSERVED]: { listedUnaddressed: 'ignore' } })).policy.gate(inChat(OBSERVED, MEMBER, false), thread(), [])).toEqual({ admissible: false, reason: 'admission_ignored' })
    // An @-only chat receives no unaddressed message, so even an inferred cell does not admit one.
    expect(setup(withTable({ [CHAT]: { listedUnaddressed: 'inferred' } })).policy.gate(inChat(CHAT, MEMBER, false), thread(), [])).toEqual({ admissible: false, reason: 'no_mention' })
    expect(setup(withTable({ [CHAT]: { unlistedUnaddressed: 'inferred' } })).policy.gate(inChat(CHAT, STRANGER, false), thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
  })
  it('listens to mentions in chats that are not listed, as the row other, only when the Feishu card says so', () => {
    expect(sources.scope(inChat('oc_elsewhere'))).toEqual({ listened: false, reason: 'chat_not_allowed' })
    const others = setup(withTable({ other: { unlistedAddressed: 'explicit' } }, { otherChats: 'mentions' }))
    expect(others.sources.scope(inChat('oc_elsewhere'))).toEqual({ listened: true, observed: false, row: 'other' })
    expect(others.policy.gate(inChat('oc_elsewhere'), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { row: 'other' } })
    expect(others.policy.gate(inChat('oc_elsewhere', STRANGER), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { row: 'other', cell: 'unlistedAddressed' } })
  })
  it('admits no inferred follow-up while Eval is off, as no other inferred candidate, and still a listed sender\'s', () => {
    const quiet = { meta: { chatId: CHAT, direct: false, mentioned: false } }
    const off = setup({ ...base, eval: { ...base.eval, mode: 'off' } }).policy
    expect(off.gate(unaddressed({ ...quiet, actor: { source: 'feishu', id: 'ou_guest' } }), thread(['ticket']), []))
      .toEqual({ admissible: false, reason: 'not_a_member' })
    expect(off.gate(unaddressed(quiet), thread(['ticket']), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { via: 'followup' } })
  })
  it('makes an explicit request of an unlisted sender\'s message whose cell is explicit, also on a Thread with Tickets, in every mode', () => {
    for (const mode of ['auto', 'observe', 'off'] as const) {
      const open = setup(withTable({ [CHAT]: { unlistedAddressed: 'explicit' } }, {}, mode))
      expect(open.policy.gate(inChat(CHAT, STRANGER), thread(['ticket']), [])).toMatchObject({ admissible: true, strength: 'explicit',
        basis: { via: 'admission', cell: 'unlistedAddressed' } })
      // A cell that is not explicit leaves the follow-up inferred, while Eval is on.
      const strict = setup(withTable({ [CHAT]: { unlistedAddressed: 'ignore' } }, {}, mode))
      expect(strict.policy.gate(inChat(CHAT, STRANGER), thread(['ticket']), [])).toMatchObject(mode === 'off'
        ? { admissible: false } : { admissible: true, strength: 'inferred', basis: { via: 'followup' } })
    }
  })
  it('keeps follow-ups on a Thread with Tickets outside the table', () => {
    const strict = setup(withTable({ [OBSERVED]: { listedUnaddressed: 'ignore', unlistedUnaddressed: 'ignore' } }))
    expect(strict.policy.gate(inChat(OBSERVED, MEMBER, false), thread(['ticket']), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { via: 'followup' } })
    expect(strict.policy.gate(inChat(OBSERVED, STRANGER, false), thread(['ticket']), [])).toMatchObject({ admissible: true, strength: 'inferred', basis: { via: 'followup' } })
  })
  it('invalidates a Mandate once its cell gives less than the strength it was accepted with, and keeps it while the cell holds', () => {
    const open = withTable({ [CHAT]: { unlistedAddressed: 'explicit' } })
    const gate = setup(open).policy.gate(inChat(CHAT, STRANGER), thread(), [])
    if (!gate.admissible) throw new Error('expected admission')
    const mandate = { strength: gate.strength, policyVersion: 'v', basis: gate.basis, actor: { source: 'feishu', id: STRANGER }, scope: '' }
    expect(setup(open).policy.revalidate(mandate)).toBe(true)
    expect(setup(withTable({ [CHAT]: { unlistedAddressed: 'inferred' } })).policy.revalidate(mandate)).toBe(false)
    expect(setup(withTable({})).policy.revalidate(mandate)).toBe(false)
  })
  it('changes the Policy version when a cell changes', () => {
    expect(setup(withTable({ [CHAT]: { unlistedAddressed: 'explicit' } })).version).not.toBe(setup().version)
    expect(setup(withTable({})).version).toBe(setup().version)
  })
})
describe('revalidating a Mandate from the admission table', () => {
  type Cell = 'listedUnaddressed' | 'unlistedAddressed' | 'unlistedUnaddressed'
  const cells: Cell[] = ['listedUnaddressed', 'unlistedAddressed', 'unlistedUnaddressed']
  const SENDER = 'ou_sender'
  const origins: { cell: Cell; strength: 'explicit' | 'inferred' }[] = [
    { cell: 'listedUnaddressed', strength: 'inferred' }, { cell: 'unlistedAddressed', strength: 'explicit' },
    { cell: 'unlistedAddressed', strength: 'inferred' }, { cell: 'unlistedUnaddressed', strength: 'inferred' },
  ]
  const cases = origins.flatMap(origin => [true, false].flatMap(listed => (['off', 'observe', 'auto'] as const).flatMap(mode => [true, false].flatMap(rule =>
    (['all', 'mentions', 'none'] as const).flatMap(scope => [true, false].map(holds => ({ ...origin, listed, mode, rule, scope, holds })))))))
  /** docs/002: the Thread must still be received; a listed sender who addresses the agent is explicit; a sender listed since takes the listed cell. */
  function expected({ cell, strength, listed, mode, rule, scope, holds }: typeof cases[number]): boolean {
    if (scope === 'none') return false
    if (cell === 'unlistedAddressed' && listed) return true
    const now = cell === 'unlistedUnaddressed' && listed ? 'listedUnaddressed' : cell
    if ((now === 'listedUnaddressed' && !listed) || !holds) return false
    return strength === 'explicit' || (mode === 'auto' && rule)
  }
  it.each(cases)('$cell ($strength), listed now $listed, mode $mode, rule on $rule, chat receives $scope, cell holds $holds', item => {
    // The row gives each cell the strength the Mandate was accepted with, or, when it no longer holds, ignore.
    const grant = (cell: Cell) => !item.holds ? 'ignore' : cell === 'unlistedAddressed' ? item.strength : 'inferred'
    const chats = item.scope === 'none' ? [] : [{ chatId: CHAT, listen: item.scope }]
    const settings = SettingsSchema.parse({
      eval: { mode: item.mode },
      sources: { feishu: feishuSource({ chats, directMessages: true }) },
      policy: {
        rules: [{ id: 'copy', name: 'Copy', enabled: item.rule, instruction: 'x' }],
        sources: { feishu: { allowed: item.listed ? [{ id: SENDER }] : [], admission: { [CHAT]: Object.fromEntries(cells.map(cell => [cell, grant(cell)])) } } },
      },
    })
    const addressed = item.cell === 'unlistedAddressed'
    const observed = item.strength === 'inferred' ? { observation: { mode: 'auto' as const }, rules: ['copy'] } : {}
    const basis: MandateBasis = { via: 'admission', source: 'feishu', scope: { chatId: CHAT, direct: false, mentioned: addressed }, row: CHAT, cell: item.cell,
      ...addressed ? { addressed: 'mention' as const } : {}, ...observed }
    const mandate = { strength: item.strength, policyVersion: 'v', basis, actor: { source: 'feishu', id: SENDER }, scope: '' }
    expect(setup(settings).policy.revalidate(mandate)).toBe(expected(item))
  })
})
describe('revalidate and version', () => {
  it('keeps explicit Mandates while the sender stays allowed and the Source still listens, and rule Mandates only while auto mode and the rules hold', () => {
    const basis: MandateBasis = { via: 'addressed', source: 'feishu', scope: { chatId: CHAT, direct: false }, sender: 'Alice', addressed: 'mention' }
    const mandate = { strength: 'explicit' as const, policyVersion: 'v', basis, actor: { source: 'feishu', id: MEMBER }, scope: '' }
    expect(policy.revalidate(mandate)).toBe(true)
    const nobody = { ...base, policy: { ...base.policy, sources: {} } }
    expect(setup(nobody).policy.revalidate(mandate)).toBe(false)
    const silent = { ...base, sources: { feishu: feishuSource({ chats: [], directMessages: true }) } }
    expect(setup(silent).policy.revalidate(mandate)).toBe(false)
    // A Mandate from before the gate recorded how it admitted a Trigger holds while its sender is listed and the Source listens.
    const listed: MandateBasis = { via: 'listed', source: 'feishu', scope: { chatId: CHAT, direct: false }, sender: 'Alice' }
    expect(setup(silent).policy.revalidate({ ...mandate, basis: listed })).toBe(false)
    expect(policy.revalidate({ ...mandate, basis: listed })).toBe(true)
    const inferred = { ...mandate, strength: 'inferred' as const, basis: { via: 'listed', observation: {}, rules: ['copy'] } satisfies MandateBasis }
    expect(policy.revalidate(inferred)).toBe(true)
    expect(setup({ ...base, eval: { ...base.eval, mode: 'observe' } }).policy.revalidate(inferred)).toBe(false)
    expect(setup({ ...base, policy: { ...base.policy, rules: base.policy.rules.map(rule => ({ ...rule, enabled: rule.id !== 'copy' })) } }).policy.revalidate(inferred)).toBe(false)
    expect(setup(nobody).policy.revalidate({ ...mandate, basis: { via: 'followup' } })).toBe(true)
  })
  it('changes the Policy version for rules, accept mode and the Sources\' parts, not for pause, concurrency, models or Source configuration', () => {
    const version = setup().version
    expect(setup({ ...base, paused: true, executor: { ...base.executor, maxWorkers: 9 }, eval: { ...base.eval, timeoutSeconds: 300 }, sources: { ...base.sources, github: { enabled: true, config: { pollSeconds: 600 } } } }).version).toBe(version)
    expect(setup({ ...base, sources: { feishu: feishuSource({ chats: [], directMessages: false }) } }).version).toBe(version)
    expect(setup({ ...base, eval: { ...base.eval, mode: 'off' } }).version).not.toBe(version)
    expect(setup({ ...base, policy: { ...base.policy, sources: { ...base.policy.sources, github: { allowed: [], admission: {} } } } }).version).not.toBe(version)
  })
})
describe('revalidating a self-authenticating Source', () => {
  function bqaSetup(enabled = true) {
    const settings = SettingsSchema.parse({ sources: { bqa: { enabled, config: {} } } })
    const sources = new SourceRegistry(() => settings)
    sources.register(bqaKind)
    return { sources, policy: settingsPolicy(settings, sources) }
  }
  const mandate: Mandate = { strength: 'explicit', policyVersion: 'v', basis: { via: 'addressed', source: 'bqa', addressed: 'direct' },
    actor: { source: 'bqa', id: 'user-1' }, scope: '' }
  it('T5: resumes an addressed Mandate without the allow-list while the Source listens, and refuses it once disabled or uninstalled', () => {
    const listening = bqaSetup()
    expect(listening.sources.authenticates('bqa')).toBe(true)
    expect(listening.policy.revalidate(mandate)).toBe(true)
    // The Source's own authentication is the only admission path: disabled, it no longer vouches for anyone.
    const disabled = bqaSetup(false)
    expect(disabled.sources.authenticates('bqa')).toBe(false)
    expect(disabled.policy.revalidate(mandate)).toBe(false)
    // A Source whose plugin is not installed authenticates nothing.
    const bare = new SourceRegistry(() => SettingsSchema.parse({ sources: { bqa: { enabled: true, config: {} } } }))
    expect(bare.authenticates('bqa')).toBe(false)
    expect(settingsPolicy(SettingsSchema.parse({ sources: { bqa: { enabled: true, config: {} } } }), bare).revalidate(mandate)).toBe(false)
    // Every other Source keeps the allow-list rule.
    const feishuMandate: Mandate = { strength: 'explicit', policyVersion: 'v', scope: '',
      basis: { via: 'addressed', source: 'feishu', scope: { chatId: CHAT, direct: false }, addressed: 'mention' }, actor: { source: 'feishu', id: 'ou_guest' } }
    expect(policy.revalidate(feishuMandate)).toBe(false)
    expect(policy.revalidate({ ...feishuMandate, actor: { source: 'feishu', id: MEMBER } })).toBe(true)
  })
})
describe('settings migration', () => {
  it('moves each member\'s identity into each Source\'s part of the Policy and drops the fields prompts and the execution environment replaced', () => {
    const saved = SettingsSchema.parse(migrateSettings({
      policy: { members: [{ name: 'Alice', feishuId: MEMBER, github: 'alice' }, { name: 'Bob', feishuId: 'ou_bob', github: '' }, { name: 'Carol', feishuId: '', github: 'carol' }], memberChat: CHAT, autoMergeLineLimit: 300,
        rules: [{ id: 'visual', name: 'V', enabled: true, visual: true, instruction: 'x' }] },
      executor: { maxWorkers: 2, reviewer: 'dave', visualReviewer: 'carol', branchPrefix: 'bot/' },
      sources: { feishu: { enabled: true, config: { chats: [], directMessages: true }, authority: { chats: [] } } },
    }))
    expect(saved.policy).toEqual({
      rules: [{ id: 'visual', name: 'V', enabled: true, instruction: 'x' }],
      sources: { feishu: { allowed: [{ id: MEMBER, name: 'Alice' }, { id: 'ou_bob', name: 'Bob' }], syncChat: CHAT, admission: {} }, github: { allowed: [{ id: 'alice' }, { id: 'carol' }], admission: {} } },
    })
    expect(saved).toMatchObject({ paused: false, executor: { model: null, maxWorkers: 2, directory: '', prepare: '', blockedCommands: [] } })
    expect(saved.sources.feishu).toEqual({ enabled: true, config: { chats: [], directMessages: true } })
    expect(SettingsSchema.parse(migrateSettings(saved))).toEqual(saved)
    expect(SettingsSchema.parse(migrateSettings({ executor: { maxWorkers: 2, paused: true } }))).toMatchObject({ paused: true, executor: { maxWorkers: 2 } })
  })
  it('moves pre-domain chat lists into the Feishu Source, the pause into a setting of its own, and members into the Sources\' parts', () => {
    const migrated = SettingsSchema.parse(migrateSettings({ paused: true, allowedChats: [CHAT, OBSERVED], allowDirectMessages: false, pollSeconds: 120, maxWorkers: 5, members: [{ name: 'A', feishuId: MEMBER, github: 'a' }],
      models: { orchestrator: { provider: 'p', model: 'm' }, worker: null, admission: null }, admission: { mode: 'auto', chats: [OBSERVED], maxEvaluators: 1, timeoutSeconds: 90, rules: [] } }))
    expect(migrated).toEqual({
      paused: true,
      sources: { feishu: feishuSource({ chats: [{ chatId: CHAT, listen: 'mentions' }, { chatId: OBSERVED, listen: 'all' }], directMessages: false }), github: { enabled: true, config: { pollSeconds: 120 } } },
      policy: { rules: [], sources: { feishu: { allowed: [{ id: MEMBER, name: 'A' }], admission: {} }, github: { allowed: [{ id: 'a' }], admission: {} } } },
      eval: { mode: 'auto', timeoutSeconds: 90, model: { provider: 'p', model: 'm' }, batches: {} },
      executor: { engine: 'dsh', model: null, maxWorkers: 5, directory: '', directoryMode: 'per-ticket', prepare: '', blockedCommands: [],
        claudeBin: '', opencodeBin: '', claudePermissionMode: 'auto', claudeApproval: 'approve', claudeUltracode: false,
        opencodeAgent: '', opencodeApproval: 'smart', opencodePermissionPreset: 'smart', opencodePermissionRules: [],
        taskTypes: [] },
    })
    expect(migrateSettings(migrated)).toEqual(migrated)
  })
  it('leaves chats that were observed only while admission was off outside the Feishu Source', () => {
    const migrated = SettingsSchema.parse(migrateSettings({ allowedChats: [CHAT], members: [], admission: { mode: 'off', chats: [OBSERVED] } }))
    expect(migrated.sources.feishu!.config).toEqual({ chats: [{ chatId: CHAT, listen: 'mentions' }], directMessages: true })
  })
})

it('renames the variables a stored prepare command reads from earlier project names to the current one', () => {
  const settings = SettingsSchema.parse(migrateSettings({ executor: { prepare: 'git worktree add "$DSH_TAG_DIR" -b "agent/${DSH_GO_NAME}" "refs/x/$DSH_FREELANCER_TICKET"' } }))
  expect(settings.executor.prepare).toBe('git worktree add "$DSH_SUPERAGENT_DIR" -b "agent/${DSH_SUPERAGENT_NAME}" "refs/x/$DSH_SUPERAGENT_TICKET"')
})

it('reads a stored GitHub Source configuration that names a merge account without it', () => {
  const settings = SettingsSchema.parse(migrateSettings({ sources: { github: { enabled: true, config: { repository: 'acme/widgets', cli: 'gh-agent', mergeCli: 'gh-merge-account', pollSeconds: 120 } } } }))
  expect(settings.sources.github!.config).toEqual({ repository: 'acme/widgets', cli: 'gh-agent', pollSeconds: 120 })
})

describe('assessment outcomes', () => {
  const settings = (mode: 'auto' | 'observe') => {
    const parsed = SettingsSchema.parse({})
    return { ...parsed, eval: { ...parsed.eval, mode } }
  }
  const direction = { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'asked' }
  const judged = (current: ReturnType<typeof settings>, matched: boolean) =>
    current.policy.rules.filter(rule => rule.enabled).map(rule => ({ rule_id: rule.id, matched, reason: 'judged' }))
  const accept = (current: ReturnType<typeof settings>, matched = true) => ({ decision: 'accept' as const, rule_assessments: judged(current, matched),
    direction, title: 'Fix', scope: 'small', reason: 'asked', intent_evidence: 'quote', worktree_name: 'fix-copy' })
  it('accepts an inferred candidate on its matched rules in auto mode only, and the Policy admits only enabled matched rules', () => {
    const auto = settings('auto')
    const outcome = assessmentOutcome(accept(auto), auto, 'inferred')
    expect(outcome).toMatchObject({ kind: 'accept', rules: auto.policy.rules.filter(rule => rule.enabled).map(rule => rule.id), name: 'fix-copy' })
    expect(assessmentOutcome(accept(settings('observe')), settings('observe'), 'inferred'))
      .toMatchObject({ kind: 'ignore', reason: { code: 'observed', values: { text: 'asked' } }, audit: { would_accept: true } })
    expect(assessmentOutcome(accept(auto, false), auto, 'inferred')).toMatchObject({ kind: 'ignore', reason: { code: 'noRuleMatched' } })
    expect(() => assessmentOutcome({ ...accept(auto), rule_assessments: [] }, auto, 'inferred')).toThrow('Exactly one assessment for every enabled rule')
    expect(() => assessmentOutcome({ ...accept(auto), intent_evidence: null }, auto, 'inferred')).toThrow('Acceptance requires intent_evidence')
    const scope = { scope: () => ({ listened: true as const, observed: true }) }
    const enabled = auto.policy.rules.find(rule => rule.enabled)!.id
    expect(settingsPolicy(auto, scope).admitsInferred([enabled])).toBe(true)
    expect(settingsPolicy(auto, scope).admitsInferred(['unknown'])).toBe(false)
    expect(settingsPolicy(auto, scope).admitsInferred([])).toBe(false)
    expect(settingsPolicy(settings('observe'), scope).admitsInferred([enabled])).toBe(false)
  })
})

describe('admission table settings', () => {
  it('allows an explicit cell for a listed sender who never addresses the agent, as the UME Source needs, but not for unlisted ones', () => {
    const listed = { allowed: [{ id: MEMBER }], admission: { [CHAT]: { listedUnaddressed: 'explicit' } } }
    expect(SettingsSchema.parse({ policy: { sources: { feishu: listed } } }).policy.sources.feishu!.admission[CHAT]!.listedUnaddressed).toBe('explicit')
    expect(sources.validatePolicy({ feishu: listed }).feishu).toMatchObject({ admission: { [CHAT]: { listedUnaddressed: 'explicit' } } })
    const unlisted = { allowed: [], admission: { [CHAT]: { unlistedUnaddressed: 'explicit' } } }
    expect(() => SettingsSchema.parse({ policy: { sources: { feishu: unlisted } } })).toThrow()
    expect(() => sources.validatePolicy({ feishu: unlisted })).toThrow()
  })
  it('accepts an explicit candidate whatever the accept mode, which bears only on inferred ones', () => {
    const rules = SettingsSchema.parse({}).policy.rules.filter(rule => rule.enabled)
    const direction = { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'asked' }
    const assessment = { decision: 'accept' as const, direction, title: 'Fix', scope: 'small', reason: 'asked', intent_evidence: 'quote',
      rule_assessments: rules.map((rule, index) => ({ rule_id: rule.id, matched: index === 0, reason: 'judged' })) }
    for (const mode of ['observe', 'off'] as const) {
      const settings = SettingsSchema.parse({ eval: { mode } })
      expect(assessmentOutcome(assessment, settings, 'explicit')).toMatchObject({ kind: 'accept', title: 'Fix' })
      expect(assessmentOutcome(assessment, settings, 'inferred')).toMatchObject({ kind: 'ignore', reason: { code: 'observed' } })
    }
  })
  it('admits a listed bot that mentions the agent where the Source does not observe its messages, as a listed person\'s mention needs none', () => {
    const settings = SettingsSchema.parse({ ...base, policy: { ...base.policy, sources: { ...base.policy.sources,
      feishu: { ...base.policy.sources.feishu, bots: [{ id: 'cli_alerts' }] } } } })
    const mention = feishu({ actor: { source: 'feishu', id: 'cli_alerts' }, human: false, meta: { chatId: CHAT, direct: false, mentioned: true } })
    expect(setup(settings).policy.gate(mention, thread(), [])).toMatchObject({ admissible: true, strength: 'inferred',
      basis: { via: 'bot', addressed: 'mention', row: CHAT } })
  })
})
describe('rule judgements', () => {
  it('refuses an assessment that judges one enabled rule twice and leaves another unjudged', () => {
    const parsed = SettingsSchema.parse({ eval: { mode: 'auto' }, policy: { rules: [{ id: 'copy', name: 'Copy', enabled: true, instruction: 'Fix typos.' },
      { id: 'visual', name: 'Visual', enabled: true, instruction: 'Fix colors.' }] } })
    const direction = { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'asked' }
    const assessment = { decision: 'accept' as const, direction, title: 'Fix', scope: 'small', reason: 'asked', intent_evidence: 'quote',
      rule_assessments: [{ rule_id: 'copy', matched: true, reason: 'typo' }, { rule_id: 'copy', matched: false, reason: 'again' }] }
    expect(() => assessmentOutcome(assessment, parsed, 'inferred')).toThrow('Exactly one assessment for every enabled rule')
    const once = { ...assessment, rule_assessments: [assessment.rule_assessments[0]!, { rule_id: 'visual', matched: false, reason: 'no colors' }] }
    expect(assessmentOutcome(once, parsed, 'inferred')).toMatchObject({ kind: 'accept', rules: ['copy'] })
  })
})
describe('policy effects', () => {
  const scope = () => ({ scope: () => ({ listened: true as const, observed: true }) })
  const base = SettingsSchema.parse({ policy: { rules: [{ id: 'copy', name: 'Copy', enabled: true, instruction: 'Fix typos.' },
    { id: 'visual', name: 'Visual', enabled: true, instruction: 'Fix colors.' }],
    sources: { feishu: { allowed: [{ id: 'ou_alice' }] } } } })
  const ticket = (id: string, mandate: object) => ({ id, mandate } as unknown as Ticket)
  const inferred = ticket('t1', { strength: 'inferred', actor: { source: 'feishu', id: 'ou_guest' }, basis: { via: 'listed', rules: ['copy'] } })
  const explicit = ticket('t2', { strength: 'explicit', actor: { source: 'feishu', id: 'ou_alice' }, basis: { via: 'listed', source: 'feishu' } })
  it('tells a ticket how a change bears on it, and leaves the others alone', () => {
    const rules = (copy: object, visual: object = {}) => ({ ...base, policy: { ...base.policy, rules: [{ ...base.policy.rules[0]!, ...copy }, { ...base.policy.rules[1]!, ...visual }] } })
    // A rule the ticket was not accepted under changes nothing for it.
    expect(policyEffects([inferred, explicit], base, rules({}, { enabled: false }), scope).size).toBe(0)
    expect(policyEffects([inferred], base, rules({ instruction: 'Fix typos only.' }), scope).get('t1'))
      .toEqual({ rules: [{ id: 'copy', name: 'Copy', change: 'changed', instruction: 'Fix typos only.' }] })
    expect(policyEffects([inferred], base, rules({ enabled: false }), scope).get('t1')).toEqual({ rules: [{ id: 'copy', name: 'Copy', change: 'disabled' }] })
    // Another sender on the list, as a member sync adds, bears on no ticket; taking the requester off it does.
    const allowed = (list: { id: string }[]) => ({ ...base, policy: { ...base.policy, sources: { ...base.policy.sources, feishu: { ...base.policy.sources.feishu!, allowed: list } } } })
    expect(policyEffects([inferred, explicit], base, allowed([{ id: 'ou_alice' }, { id: 'ou_bob' }]), scope).size).toBe(0)
    expect(policyEffects([explicit], base, allowed([]), scope).get('t2')).toEqual({ requesterAllowed: false, requester: { source: 'feishu', id: 'ou_alice' } })
  })
  it('tells an inferred ticket that inferred work is no longer accepted when the accept mode leaves auto, and names a bot it is for', () => {
    const auto = { ...base, eval: { ...base.eval, mode: 'auto' as const } }
    const observe = { ...base, eval: { ...base.eval, mode: 'observe' as const } }
    const rule = ticket('t3', { strength: 'inferred', actor: { source: 'feishu', id: 'ou_alice' },
      basis: { via: 'listed', source: 'feishu', rules: ['copy'], observation: {} } })
    const effects = policyEffects([rule, explicit], auto, observe, scope)
    // Not a sender's removal: the person who wrote it may still start work.
    expect(effects.get('t3')).toEqual({ proactive: false })
    expect(effects.has('t2')).toBe(false)
    const bot = ticket('t4', { strength: 'explicit', actor: { source: 'feishu', id: 'cli_ci_bot' }, basis: { via: 'listed', source: 'feishu' } })
    const listed = { ...base, policy: { ...base.policy, sources: { ...base.policy.sources, feishu: { ...base.policy.sources.feishu!, allowed: [{ id: 'cli_ci_bot' }] } } } }
    expect(policyEffects([bot], listed, base, scope).get('t4')).toEqual({ requesterAllowed: false, requester: { source: 'feishu', id: 'cli_ci_bot' } })
  })
  it('keeps an inferred follow-up\'s Mandate only while candidates become work and its rules are on, as any inferred one', () => {
    const followup = ticket('t5', { strength: 'inferred', actor: { source: 'feishu', id: 'ou_guest' }, scope: '',
      basis: { via: 'followup', source: 'feishu', scope: { chatId: 'oc_team' }, rules: ['copy'] } })
    const mode = (value: 'auto' | 'observe' | 'off') => ({ ...base, eval: { ...base.eval, mode: value } })
    const disabled = { ...mode('auto'), policy: { ...base.policy, rules: base.policy.rules.map(rule => ({ ...rule, enabled: rule.id !== 'copy' })) } }
    expect(settingsPolicy(mode('auto'), scope()).revalidate(followup.mandate)).toBe(true)
    for (const settings of [mode('observe'), mode('off'), disabled]) expect(settingsPolicy(settings, scope()).revalidate(followup.mandate)).toBe(false)
    expect(policyEffects([followup], mode('auto'), mode('observe'), scope).get('t5')).toEqual({ proactive: false })
    // An explicit follow-up holds whatever the mode.
    const explicitFollowup = ticket('t6', { ...followup.mandate, strength: 'explicit', actor: { source: 'feishu', id: 'ou_alice' } })
    expect(settingsPolicy(mode('off'), scope()).revalidate(explicitFollowup.mandate)).toBe(true)
  })
  it('revokes an inferred ticket whose cell weakens or whose candidates no longer become work, and reports a deleted rule disabled', () => {
    const chat = 'oc_1111111111111111111111111111'
    const table = (cell: 'inferred' | 'ignore', mode: 'auto' | 'observe' = 'auto') => SettingsSchema.parse({ ...base, eval: { ...base.eval, mode },
      policy: { ...base.policy, sources: { feishu: { ...base.policy.sources.feishu!, admission: { [chat]: { unlistedUnaddressed: cell } } } } } })
    const observed = () => ({ scope: () => ({ listened: true as const, observed: true, row: chat }) })
    const proactive = ticket('t3', { strength: 'inferred', actor: { source: 'feishu', id: 'ou_guest' }, scope: '',
      basis: { via: 'admission', cell: 'unlistedUnaddressed', source: 'feishu', scope: { chatId: chat }, row: chat, rules: ['copy'],
        observation: { mode: 'auto' } } })
    expect(policyEffects([proactive], table('inferred'), table('inferred'), observed).size).toBe(0)
    // A weaker cell takes the work from its sender, whom the effect names; a mode change only stops inferred work.
    expect(policyEffects([proactive], table('inferred'), table('ignore'), observed).get('t3'))
      .toEqual({ requesterAllowed: false, requester: { source: 'feishu', id: 'ou_guest' } })
    expect(policyEffects([proactive], table('inferred'), table('inferred', 'observe'), observed).get('t3')).toEqual({ proactive: false })
    const deleted = { ...base, policy: { ...base.policy, rules: base.policy.rules.filter(rule => rule.id !== 'visual') } }
    const visual = ticket('t4', { strength: 'explicit', actor: { source: 'feishu', id: 'ou_alice' },
      basis: { via: 'listed', source: 'feishu', rules: ['visual'] } })
    expect(policyEffects([visual], base, deleted, scope).get('t4')).toEqual({ rules: [{ id: 'visual', name: 'Visual', change: 'disabled' }] })
  })
})
describe('bots and events without a sender', () => {
  const observing = (config: Record<string, unknown>, part: Record<string, unknown> = {},
    mode: 'auto' | 'off' = 'auto') => SettingsSchema.parse({
    policy: { sources: { github: { allowed: [{ id: 'Alice' }], bots: [{ id: 'dependabot[bot]' }], ...part } } }, eval: { mode },
    sources: { github: { enabled: true, config } } })
  const comment: Trigger = { id: 'b', source: 'github', threads: [{ source: 'github', id: '1' }],
    actor: { source: 'github', id: 'dependabot[bot]' }, human: false, at: '', text: 'Bump lodash',
    meta: { number: 1, isPr: true, kind: 'conversation' } }
  const ci = (meta: Record<string, unknown>): Trigger => ({ id: 'ci', source: 'github', threads: [{ source: 'github', id: 'ci:main' }],
    actor: { source: 'github', id: '' }, human: false, at: '', text: 'CI failed 1/9 on main', meta: { ci: true, ...meta } })
  it('admits a bot on its Source\'s list as an inferred candidate where the Source observes its scope, and no other bot', () => {
    const { policy } = setup(observing({ observeComments: true }))
    expect(policy.gate(comment, thread(), [])).toMatchObject({ admissible: true, strength: 'inferred',
      basis: { via: 'bot', source: 'github', sender: 'dependabot[bot]', row: 'comments', observation: { mode: 'auto' } } })
    // A bot that addresses the agent still makes no explicit request; on a Thread with tickets it is no follow-up either.
    expect(policy.gate({ ...comment, addressed: 'mention' }, thread(['ticket']), [ticket])).toMatchObject({ strength: 'inferred',
      basis: { via: 'bot', addressed: 'mention' } })
    expect(policy.gate({ ...comment, actor: { source: 'github', id: 'renovate[bot]' } }, thread(), [])).toEqual({ admissible: false,
      reason: 'not_human' })
    expect(setup(observing({})).policy.gate(comment, thread(), [])).toEqual({ admissible: false, reason: 'not_human' })
    expect(setup(observing({ observeComments: true }, {}, 'off')).policy.gate(comment, thread(), [])).toEqual({ admissible: false,
      reason: 'admission_ignored' })
  })
  it('keeps a bot candidate\'s Mandate while the bot stays on its list and candidates may become work', () => {
    const settings = observing({ observeComments: true })
    const mandate = { strength: 'inferred' as const, policyVersion: '', actor: comment.actor, scope: '',
      basis: { via: 'bot' as const, source: 'github', scope: comment.meta, row: 'comments', sender: 'dependabot[bot]',
        observation: { mode: 'auto' as const } } }
    expect(setup(settings).policy.revalidate(mandate)).toBe(true)
    expect(setup(observing({ observeComments: true }, { bots: [] })).policy.revalidate(mandate)).toBe(false)
    expect(setup({ ...settings, eval: { ...settings.eval, mode: 'observe' } }).policy.revalidate(mandate)).toBe(false)
  })
  it('admits the default branch\'s CI through its row once observed and set, and never a PR\'s CI', () => {
    const admission = { ci: { unlistedUnaddressed: 'inferred' } }
    const branch = setup(observing({ observeCi: true }, { admission })).policy.gate(ci({ branch: 'main' }), thread(), [])
    expect(branch).toMatchObject({ admissible: true, strength: 'inferred',
      basis: { via: 'admission', cell: 'unlistedUnaddressed', row: 'ci', observation: { mode: 'auto' } } })
    // The cell defaults to ignore, so observing the CI changes nothing until the table says so.
    expect(setup(observing({ observeCi: true })).policy.gate(ci({ branch: 'main' }), thread(), [])).toEqual({ admissible: false,
      reason: 'admission_ignored' })
    const pull = setup(observing({ observeCi: true }, { admission })).policy.gate(ci({ number: 9, isPr: true }), thread(), [])
    expect(pull).toEqual({ admissible: false, reason: 'not_human' })
  })
  it('admits a Feishu bot on its list in a chat the Source observes', () => {
    const settings = SettingsSchema.parse({ ...base, policy: { ...base.policy, sources: { ...base.policy.sources,
      feishu: { ...base.policy.sources.feishu, bots: [{ id: 'cli_alerts', name: 'Alerts' }] } } } })
    const alert = unaddressed({ actor: { source: 'feishu', id: 'cli_alerts' }, human: false,
      meta: { chatId: OBSERVED, direct: false, mentioned: false } })
    expect(setup(settings).policy.gate(alert, thread(), []))
      .toMatchObject({ admissible: true, strength: 'inferred', basis: { via: 'bot', sender: 'Alerts', row: OBSERVED } })
    // In a chat the Source receives only mentions in, a bot's message that does not address the agent is not received.
    const unobserved = setup(settings).policy.gate({ ...alert, meta: { chatId: CHAT, direct: false, mentioned: false } }, thread(), [])
    expect(unobserved).toEqual({ admissible: false, reason: 'not_human' })
  })
  it('says on the GitHub bot list when a listed bot\'s comment is received: when it mentions the agent, or comments are observed', () => {
    const field = githubKind.policy!.fields.find(item => item.key === 'bots')!
    const comments = githubKind.fields.find(item => item.key === 'observeComments')!.label
    expect(field.hint!.en).toContain('mentions the agent')
    expect(field.hint!.en).toContain(comments.en)
    expect(field.hint!.zh).toContain(comments.zh)
  })
  it('names a GitHub Trigger\'s receiving scope, which the Source observes where its switch is on', () => {
    const { sources } = setup(observing({ observeIssues: true }))
    const github = (meta: Record<string, unknown>) => ({ source: 'github', meta })
    expect(sources.scope(github({ kind: 'issue', number: 3 }))).toEqual({ listened: true, observed: true, row: 'issues' })
    expect(sources.scope(github({ kind: 'pull', number: 4, isPr: true }))).toEqual({ listened: true, observed: false, row: 'pulls' })
    expect(sources.scope(github({ kind: 'inline', number: 4 }))).toEqual({ listened: true, observed: false, row: 'comments' })
    expect(sources.scope(github({ ci: true, branch: 'main' }))).toEqual({ listened: true, observed: false, row: 'ci' })
    expect(sources.scope(github({ ci: true, number: 4 }))).toEqual({ listened: true, observed: false })
    const rows = githubKind.policy!.rows!({ observeIssues: true })
    expect(rows.map(row => [row.id, row.cells])).toEqual([
      ['issues', { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true }],
      ['pulls', { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false }],
      ['comments', { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false }],
      ['ci', { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false }]])
  })
})

describe('task types', () => {
  const type = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id.toUpperCase(), description: `${id} work`,
    directory: `D:\\aiworkspace\\${id}`, ...extra })
  const withTypes = (types: ReturnType<typeof type>[]) => SettingsSchema.parse({ executor: { taskTypes: types } })
  it('ships no task types by default and classifies explicit, source, model and legacy evidence', () => {
    expect(SettingsSchema.parse({}).executor.taskTypes).toEqual([])
    const settings = withTypes([type('env-fix'), type('jzjy')])
    expect(classifyTaskType(settings, { explicit: 'jzjy' })).toMatchObject({ source: 'explicit', type: { id: 'jzjy' } })
    expect(classifyTaskType(settings, { explicit: 'nope', source: 'env-fix' })).toEqual({ source: 'unclassified', unknown: 'nope' })
    expect(classifyTaskType(settings, { source: 'env-fix' })).toMatchObject({ source: 'source', type: { id: 'env-fix' } })
    expect(classifyTaskType(settings, { source: 'nope', model: 'jzjy' })).toMatchObject({ source: 'model', type: { id: 'jzjy' } })
    expect(classifyTaskType(settings, {})).toEqual({ source: 'unclassified' })
    // An explicit id wins over a Source default, which wins over the assessor's choice.
    expect(classifyTaskType(settings, { explicit: 'jzjy', source: 'env-fix', model: 'env-fix' })).toMatchObject({ source: 'explicit', type: { id: 'jzjy' } })
    expect(classifyTaskType(settings, { source: 'env-fix', model: 'jzjy' })).toMatchObject({ source: 'source', type: { id: 'env-fix' } })
    // With no types configured, the legacy executor directory applies and any evidence is irrelevant.
    expect(classifyTaskType(SettingsSchema.parse({}), { explicit: 'jzjy' })).toEqual({ source: 'legacy' })
  })
  it('refuses duplicate ids and reports unclassified work', () => {
    const one = type('env-fix')
    expect(() => withTypes([one, { ...one }])).toThrow()
    const settings = withTypes([type('env-fix'), type('jzjy')])
    expect(unclassifiedTaskTypeError(settings, 'nope').message).toMatch(/Unknown task type nope/)
    expect(unclassifiedTaskTypeError(settings).message).toMatch(/Work cannot proceed unclassified/)
  })
  it('drops the removed default task type from migrated settings', () => {
    const migrated = SettingsSchema.parse(migrateSettings({ executor: { maxWorkers: 2, defaultTaskType: 'env-fix' } }))
    expect(migrated.executor.taskTypes).toEqual([])
    expect('defaultTaskType' in migrated.executor).toBe(false)
  })
  it('carries the resolved type and its evidence into an accepted outcome, and refuses unclassified acceptance', () => {
    const rules = [{ id: 'copy', name: 'Copy', enabled: true, instruction: 'Fix copy' }]
    const settings = SettingsSchema.parse({ executor: { taskTypes: [type('env-fix'), type('jzjy')] }, policy: { rules } })
    const assessment = { decision: 'accept' as const, rule_assessments: [{ rule_id: 'copy', matched: true, reason: 'x' }],
      direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'x' },
      title: 'Fix', scope: 'Fix', reason: 'r', intent_evidence: 'evidence', worktree_name: 'fix-copy' }
    expect(assessmentOutcome({ ...assessment, taskType: 'jzjy' }, settings, 'explicit'))
      .toMatchObject({ kind: 'accept', taskType: 'jzjy', taskTypeSource: 'model' })
    // The Source default classifies work the assessor leaves untyped.
    expect(assessmentOutcome(assessment, settings, 'explicit', 'env-fix'))
      .toMatchObject({ kind: 'accept', taskType: 'env-fix', taskTypeSource: 'source' })
    expect(() => assessmentOutcome(assessment, settings, 'explicit')).toThrow(/Work cannot proceed unclassified/)
    expect(() => assessmentOutcome({ ...assessment, taskType: 'nope' }, settings, 'explicit')).toThrow(/Unknown task type nope/)
    // Without configured types the legacy directory applies and no type rides along.
    const legacy = assessmentOutcome(assessment, SettingsSchema.parse({ policy: { rules } }), 'explicit')
    expect(legacy).toMatchObject({ kind: 'accept' })
    expect(legacy).not.toHaveProperty('taskType')
  })
})

describe('task type execution profile', () => {
  it('defaults every new profile field to inherit, and accepts the opencode engine and its parameters', () => {
    const settings = SettingsSchema.parse({})
    expect(settings.executor).toMatchObject({ opencodeAgent: '', opencodeApproval: 'smart',
      opencodePermissionPreset: 'smart', opencodePermissionRules: [] })
    const plain = TaskTypeSchema.parse({ id: 'docs', name: 'Docs', description: 'Docs work.', directory: 'D:\\w\\docs' })
    expect(plain).toMatchObject({ engine: null, claude: null, opencode: null, prepare: null, blockedCommands: null })
    expect(TaskTypeSchema.parse({ id: 'native', name: 'Native', description: 'Native work.', directory: 'D:\\w\\native', engine: 'opencode',
      model: { provider: 'opencode-go', model: 'kimi-k3', reasoningEffort: 'high' },
      claude: {}, opencode: { approval: 'deny', permissionPreset: 'safe' }, prepare: 'npm ci', blockedCommands: ['cli-x'] }))
      .toMatchObject({ engine: 'opencode', model: { provider: 'opencode-go', model: 'kimi-k3', reasoningEffort: 'high' },
        opencode: { approval: 'deny' }, prepare: 'npm ci', blockedCommands: ['cli-x'] })
  })
  it('resolves the shared model and each profile field over the executor fallback, field by field, with \'\' and [] as explicit none', () => {
    const model = { provider: 'deepseek-account', model: 'deepseek-flash' }
    const claudeModel = { provider: 'anthropic', model: 'sonnet' }
    const settings = SettingsSchema.parse({ executor: { model, prepare: 'global-prepare', blockedCommands: ['global-cli'],
      claudePermissionMode: 'plan', claudeApproval: 'deny', claudeUltracode: true,
      opencodeAgent: 'build', opencodeApproval: 'ask', opencodePermissionPreset: 'safe',
      taskTypes: [{ id: 'native', name: 'Native', description: 'Native work.', directory: 'D:\\w\\native', engine: 'claude-code',
        model: claudeModel, prepare: 'type-prepare', blockedCommands: [], claude: { permissionMode: 'auto', approval: 'approve',
          ultracode: false }, opencode: { approval: 'deny' } }] } })
    expect(executorProfile(settings, settings.executor.taskTypes[0]!)).toEqual({ engine: 'claude-code', model: claudeModel,
      prepare: 'type-prepare',
      blockedCommands: [], claude: { bin: '', permissionMode: 'auto', approval: 'approve', ultracode: false },
      opencode: { agent: 'build', approval: 'deny', permissionPreset: 'safe', permissionRules: [] } })
    // Everything a type leaves null inherits; a type that sets no profile, and no type at all, resolve to the fallbacks.
    const inherited = { engine: 'dsh', model, prepare: 'global-prepare', blockedCommands: ['global-cli'],
      claude: { bin: '', permissionMode: 'plan', approval: 'deny', ultracode: true },
      opencode: { agent: 'build', approval: 'ask', permissionPreset: 'safe', permissionRules: [] } }
    expect(executorProfile(settings, TaskTypeSchema.parse({ id: 'plain', name: 'Plain', description: 'Plain work.',
      directory: 'D:\\w\\plain' }))).toEqual(inherited)
    expect(executorProfile(settings, undefined)).toEqual(inherited)
    // A type on another engine does not inherit the executor's model: a route belongs to one engine.
    expect(executorProfile(settings, TaskTypeSchema.parse({ id: 'other', name: 'Other', description: 'Other work.',
      directory: 'D:\\w\\other', engine: 'opencode' })).model).toBeNull()
  })
  it('resolves a worker\'s opencode profile from the Ticket snapshot, then its type, then the global fallback', () => {
    const settings = SettingsSchema.parse({ executor: { model: { provider: 'opencode-go', model: 'global-model' },
      opencodeAgent: 'global-agent',
      opencodeApproval: 'ask', opencodePermissionPreset: 'safe',
      opencodePermissionRules: [{ action: 'shell', resource: 'git push *', effect: 'deny' }],
      taskTypes: [{ id: 'native', name: 'Native', description: 'Native work.', directory: 'D:\\w\\native', engine: 'opencode',
        model: { provider: 'opencode-go', model: 'type-model' }, opencode: { agent: 'type-agent', approval: 'smart' } }] } })
    const ticket = (execution: Record<string, unknown> = {}): Ticket => ({ execution: { name: 'native-1', directory: 'D:\\w\\native',
      assignment: '', ...execution } }) as Ticket
    // A Ticket accepted before the snapshot existed resolves its type over the global fallback, field by field.
    expect(opencodeSettingsForTicket(settings, ticket({ taskType: 'native' }))).toMatchObject({ opencodeAgent: 'type-agent',
      opencodeApproval: 'smart', opencodePermissionPreset: 'safe',
      opencodePermissionRules: [{ action: 'shell', resource: 'git push *', effect: 'deny' }] })
    expect(ticketModel(settings, ticket({ taskType: 'native' }))).toEqual({ provider: 'opencode-go', model: 'type-model' })
    // The snapshot wins whole over both the type and the global fallback.
    const snapshot = ticket({ taskType: 'native', model: { provider: 'opencode-go', model: 'snap-model' },
      engineOptions: { opencode: { agent: 'plan', approval: 'deny', permissionPreset: 'full', permissionRules: [] } } })
    expect(opencodeSettingsForTicket(settings, snapshot)).toMatchObject({ opencodeAgent: 'plan', opencodeApproval: 'deny',
      opencodePermissionPreset: 'full', opencodePermissionRules: [] })
    expect(ticketModel(settings, snapshot)).toEqual({ provider: 'opencode-go', model: 'snap-model' })
    // No type at all (legacy Ticket) resolves the global fallback.
    expect(opencodeSettingsForTicket(settings, ticket())).toMatchObject({ opencodeAgent: 'global-agent',
      opencodeApproval: 'ask', opencodePermissionPreset: 'safe' })
    expect(ticketModel(settings, ticket())).toEqual({ provider: 'opencode-go', model: 'global-model' })
  })
  it('enforces the union of the executor\'s blocked commands and every type\'s declared list', () => {
    const settings = SettingsSchema.parse({ executor: { blockedCommands: ['global-cli', 'shared-cli'],
      taskTypes: [{ id: 'a', name: 'A', description: 'A work.', directory: 'D:\\w\\a', blockedCommands: ['type-a-cli', 'shared-cli'] },
        { id: 'b', name: 'B', description: 'B work.', directory: 'D:\\w\\b', blockedCommands: [] },
        { id: 'c', name: 'C', description: 'C work.', directory: 'D:\\w\\c' }] } })
    expect(deploymentBlockedCommands(settings)).toEqual(['global-cli', 'shared-cli', 'type-a-cli'])
    expect(deploymentBlockedCommands(SettingsSchema.parse({ executor: { blockedCommands: ['only-global'] } }))).toEqual(['only-global'])
  })
})
