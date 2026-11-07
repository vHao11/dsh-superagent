// @vitest-environment jsdom
// The Execution status, a Ticket, and the Execution settings.
import { act } from 'react'
import { expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, all, find, tab, click, type, text, field, at } from './fixtures/panel.tsx'
import { MEMBER, server, ticketSummary, threadSummary } from './fixtures/panel-server.ts'
import type { Settings } from '../src/client/api.ts'

const seededTaskTypes = (): Settings['executor']['taskTypes'] => [
  { id: 'env-fix', name: '环境修复类问题', description: '修复构建环境与依赖问题', examples: [], not: [], directory: '/srv/work/env-fix',
    model: null, directoryMode: 'fixed', instructions: '', readOnly: false, engine: null, claude: null, opencode: null, prepare: null,
    blockedCommands: null },
  { id: 'jzjy', name: '集中交易类问题', description: '集中交易相关的问题修复', examples: [], not: [], directory: '/srv/work/jzjy',
    model: null, directoryMode: 'fixed', instructions: '', readOnly: false, engine: null, claude: null, opencode: null, prepare: null,
    blockedCommands: null },
  { id: 'zrt', name: '转融通系统问题', description: '转融通系统相关的问题修复', examples: [], not: [], directory: '/srv/work/zrt',
    model: null, directoryMode: 'fixed', instructions: '', readOnly: false, engine: null, claude: null, opencode: null, prepare: null,
    blockedCommands: null },
]
/** Whether the rendered form has a control for `label`; hidden host-only fields must not answer. */
const hasField = (label: string) => all('input, textarea, select').some(element => element.getAttribute('aria-label') === label
  || (!!element.id && all('label').some(item => (item as HTMLLabelElement).htmlFor === element.id && item.textContent === label)))

usePanel()
it('lists Tickets under Execution by who they wait on, with the Executor state and its pause as an action', async () => {
  server.tickets.open = [ticketSummary(), ticketSummary({ id: 't2', title: '执行中的工单', threads: [{ key: 'github:7',
    source: 'github', title: '#7 x', facts: { number: { value: '#7' }, autoMerge: { label: { zh: '自动合并', en: 'Auto-merge' },
      value: { zh: '已开启', en: 'on' } } } }] })]
  await mount()
  await click(zh['tab.execution'])
  expect(document.querySelector('.dt-status-title')?.textContent).toBe(zh.statusTitle)
  expect(server.requests.some(request => request.path === 'tickets?state=open&limit=20')).toBe(true)
  expect(text()).toContain(zh.executorRunning)
  expect(all('.dt-chip').map(chip => chip.textContent)).toContain('GitHub#7自动合并已开启')
  await click(zh.idleLabel)
  expect(server.requests.some(request => request.path === 'tickets?state=idle&limit=20')).toBe(true)
  expect(text()).toContain('执行器结束了当前回合')
  await click(zh['ticket.ended'])
  expect(text()).toContain('旧工单')
  expect(text()).toContain(zh['outcome.stopped'])
  expect(all('.dt-status-line .dt-lv').map(item => item.textContent)).toEqual(['执行中 2 / 3', '排队 0'])
  // The pause is its own action: an Execution settings draft started before it still saves.
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  expect(tab(zh['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['promptPart.runtime/work'])
  await type(field<HTMLInputElement>(zh.maxWorkers), '4')
  await click(tab(zh['tab.execution']))
  await click(zh.pauseProcessing)
  await click(zh.confirm)
  expect(server.requests.find(request => request.path === 'executor/pause')).toMatchObject({ method: 'POST', body: { paused: true } })
  expect(text()).toContain(zh.processingPaused)
  expect(find(zh.resumeProcessing).textContent).toBe(zh.resumeProcessing)
  await click(tab(zh['tab.settings']))
  await click(zh.save)
  expect(server.settings).toMatchObject({ paused: true, executor: { maxWorkers: 4 } })
})

it('shows the task type a Ticket was accepted with and how it was chosen', async () => {
  const typed = { taskType: 'docs', taskTypeName: '文档' }
  server.tickets.open = [ticketSummary({ ...typed, taskTypeSource: 'model' })]
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!, ...typed, taskTypeSource: 'source' }
  await mount()
  await click(zh['tab.execution'])
  expect(text()).toContain(zh.taskTypeLabel)
  expect(text()).toContain('文档')
  expect(all('.dt-ticket-meta .dt-hint').map(hint => hint.textContent)).toContain(` · ${zh.taskTypeSourceModel}`)
  await click(all('.dt-open').find(button => button.textContent === '修复回归')!)
  expect(document.querySelector('.dt-status-line')?.textContent).toContain(zh.taskTypeSourceSource)
  await click(zh.identifiers)
  expect(all('.dt-kv .dt-hint').map(hint => hint.textContent)).toContain(` · ${zh.taskTypeSourceSource}`)
})

it('filters the open Tickets by task type from the route', async () => {
  server.settings = { ...server.settings, executor: { ...server.settings.executor, taskTypes: seededTaskTypes() } }
  server.tickets.open = [ticketSummary({ taskType: 'env-fix', taskTypeName: '环境修复类问题' }),
    ticketSummary({ id: 't2', title: '文档工单', taskType: 'docs', taskTypeName: '文档' })]
  await mount()
  await click(zh['tab.execution'])
  const select = field<HTMLSelectElement>(zh.ticketTypeFilter)
  expect([...select.options].map(option => option.textContent)).toEqual([zh.ticketTypeAll, '环境修复类问题', '集中交易类问题', '转融通系统问题'])
  await type(select, 'env-fix')
  expect(server.requests.some(request => request.path === 'tickets?state=open&limit=20&taskType=env-fix')).toBe(true)
  expect(text()).toContain('环境修复类问题')
  expect(text()).not.toContain('文档工单')
})

it('edits one task type at a time from a selector, folding the others and keeping each type\'s own edits', async () => {
  server.settings = { ...server.settings, executor: { ...server.settings.executor, taskTypes: seededTaskTypes() } }
  at({ page: 'settings', query: { group: 'execution' } })
  await mount()
  const selector = () => field<HTMLSelectElement>(zh.taskTypeSelect)
  // The seeded types fold into one selector, and only the chosen type's form is rendered.
  expect([...selector().querySelectorAll('option')].map(option => option.textContent)).toEqual(['环境修复类问题', '集中交易类问题', '转融通系统问题'])
  expect(all('label').filter(label => label.textContent === zh.taskTypeName)).toHaveLength(1)
  expect(field<HTMLInputElement>(zh.taskTypeId).value).toBe('env-fix')
  // Choosing a type shows that type's values.
  await type(selector(), '1')
  expect(field<HTMLInputElement>(zh.taskTypeId).value).toBe('jzjy')
  expect(field<HTMLTextAreaElement>(zh.taskTypeDescription).value).toContain('集中交易')
  // An edit belongs to its type, not to the selector position.
  await type(field<HTMLTextAreaElement>(zh.taskTypeInstructions), '只改集中交易相关代码')
  await type(selector(), '2')
  expect(field<HTMLTextAreaElement>(zh.taskTypeInstructions).value).toBe('')
  await type(selector(), '1')
  expect(field<HTMLTextAreaElement>(zh.taskTypeInstructions).value).toBe('只改集中交易相关代码')
  // Adding opens the new type; removing it asks once more, and cancelling keeps the type.
  await click(zh.taskTypeAdd)
  expect([...selector().querySelectorAll('option')]).toHaveLength(4)
  expect(field<HTMLInputElement>(zh.taskTypeId).value).toBe('custom-4')
  await click(zh.taskTypeRemove)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(`删除“custom-4”`)
  expect([...selector().querySelectorAll('option')]).toHaveLength(4)
  await click(zh.cancel)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect([...selector().querySelectorAll('option')]).toHaveLength(4)
  // Confirming the removal drops the type and selects a remaining one.
  await click(zh.taskTypeRemove)
  await click(zh.confirm)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect([...selector().querySelectorAll('option')]).toHaveLength(3)
  expect(field<HTMLInputElement>(zh.taskTypeId).value).toBe('zrt')
  await click(zh.save)
  expect(server.settings.executor.taskTypes.map(type => type.id)).toEqual(['env-fix', 'jzjy', 'zrt'])
  expect(server.settings.executor.taskTypes[1]!.instructions).toBe('只改集中交易相关代码')
  // There is no default type any more, so the panel never sends the removed setting.
  expect(server.requests.find(request => request.path === 'settings/executor')?.body).not.toHaveProperty('value.defaultTaskType')
})

it('starts an empty task type list with an add action instead of a form', async () => {
  at({ page: 'settings', query: { group: 'execution' } })
  await mount()
  expect(server.settings.executor.taskTypes).toEqual([])
  expect(text()).toContain(zh.taskTypesRule)
  expect(text()).toContain(zh.taskTypeEmpty)
  await click(zh.taskTypeAdd)
  expect([...field<HTMLSelectElement>(zh.taskTypeSelect).querySelectorAll('option')].map(option => option.textContent)).toEqual(['custom-1'])
  expect(field<HTMLInputElement>(zh.taskTypeId).value).toBe('custom-1')
})

it('stops an open Ticket from its page after confirmation', async () => {
  await mount()
  await click('修复回归')
  await click(zh.stop)
  expect(server.requests.some(request => request.path.endsWith('/stop'))).toBe(false)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('停止“修复回归”')
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'tickets/t1/stop' && request.method === 'POST')).toBe(true)
})

it('shows a Ticket with its stage, its Mandate details with the Trigger and Decision behind it, its Threads, and the rest behind disclosures', async () => {
  await mount()
  await click(all('.dt-open').find(button => button.textContent === '修复回归')!)
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('修复回归')
  // Progress is in the Channels and the Session, so the page has no report section.
  expect(all('.dt-section-title').map(title => title.querySelector('.dt-section-name')?.textContent)).toEqual(['授权详情', '未送达的输入', '订阅的线程'])
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(zh.executingLabel)
  expect(document.querySelector('.dt-status-line .dt-stage .dt-spinner')).not.toBeNull()
  // A Thread this Ticket follows reads as subscribed on its page, though no other Ticket follows it.
  expect(all('.dt-list .dt-ticket .dt-stage').map(stage => stage.textContent)).toContain(zh.threadSubscribed)
  expect(all('.dt-list .dt-ticket .dt-stage').map(stage => stage.textContent)).not.toContain(zh.threadUnsubscribed)
  expect(all('.dt-status-line .dt-lv').map(item => item.textContent)).toEqual(['授权 明确', '发起 飞书 · Alice', expect.stringMatching(/^更新 /)])
  for (const expected of ['修复登录页回归', '点名方式@ 智能体', '名单里的人明确请求，由主 Session 接单', '未送达：等待派工运行',
    'Alice：顺便改标题']) expect(text()).toContain(expected)
  expect(all('.dt-chip').map(chip => chip.textContent)).toContain('飞书团队群')
  await click(zh['term.channel'])
  expect(all('.dt-disclosure-body a').map(link => [link.textContent, link.getAttribute('href')])).toEqual([['飞书消息',
    'https://applink.feishu.cn/client/chat/open?openChatId=oc_1'], ['GitHub #42', 'https://github.com/acme/widgets/issues/42']])
  await click(zh['term.environment'])
  expect(all('.dt-disclosure-body .dt-table tr').map(row => row.textContent)).toEqual(['DSH_SUPERAGENT_DIR/w/t1',
    'DSH_SUPERAGENT_GITHUB_NUMBER—'])
  await click(document.querySelector<HTMLElement>('.dt-trigger-link')!)
  expect(tab(zh['tab.trigger']).getAttribute('aria-selected')).toBe('true')
})

it('reports a missing Ticket instead of rendering an empty page', async () => {
  at({ page: 'execution', id: 'missing' })
  await mount()
  expect(document.querySelector('.dt-hint')?.textContent).toBe(zh.ticketNotFound)
})

it('links a question to its Channel, folds consecutive automated messages among Inputs, and shows field explanations in a hover tooltip',
  async () => {
  const ci = (id: string, at: string, failed: number) => ({ id, kind: 'trigger' as const, triggerId: `c${id}`, at, delivered: true,
    trigger: { id: `c${id}`, actor: { source: 'github', id: '' }, human: false,
      preview: `CI of PR #42 at abc1234: 10 checks, ${failed} failed, 0 running.`, thread: 'github:42' } })
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, stage: 'person', action: 'answer', attention: { id: 'q1', question: '需要确认按钮颜色' }, inputs: [ci('i3',
    '2026-09-22T00:06:00Z', 1), ci('i2', '2026-09-22T00:05:00Z', 0)] }
  await mount()
  await click(all('.dt-open').find(button => button.textContent === '修复回归')!)
  expect(all('.dt-banner a').map(link => [link.textContent, link.getAttribute('href')])).toEqual([['去飞书回答',
    'https://applink.feishu.cn/client/chat/open?openChatId=oc_1']])
  await click('已送达的输入 · 2')
  expect(all('.dt-disclosure-body .dt-row-title').map(title => title.textContent)).toEqual(['自动通知：CI of PR #42 at abc1234: 10 checks, 1 failed, 0 running.'])
  await click('同一发送者之前还有 1 条自动消息')
  expect(text()).toContain('CI of PR #42 at abc1234: 10 checks, 0 failed, 0 running.')
  await click(zh['tab.eval'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  expect(text()).not.toContain('到期后记为未完成')
  const tip = field(zh.evalTimeout).closest('.dt-field')!.querySelector<HTMLElement>('.dt-info')!
  await act(async () => { tip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('到期后记为未完成')
  expect(tip.closest('.dt-field')!.textContent).not.toContain('到期后记为未完成')
  await act(async () => { tip.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
})

it('offers a Ticket awaiting review its review place and Session in the page head', async () => {
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, stage: 'person', action: 'review', threads: [threadSummary(),
    { ...threadSummary({ key: 'github:42', source: 'github', title: '#42 Fix login' }), url: 'https://github.com/acme/widgets/pull/42' }] }
  at({ page: 'execution', id: 't1' })
  await mount()
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(zh['stage.review'])
  expect(all('.dt-page-head a').map(link => [link.textContent, link.getAttribute('href')])).toEqual([['打开 GitHub 原文',
    'https://github.com/acme/widgets/pull/42']])
})

it('renders the Execution settings as two cards and keeps the global fallback fields out of the DOM', async () => {
  server.settings = { ...server.settings, executor: { ...server.settings.executor, taskTypes: seededTaskTypes() } }
  at({ page: 'settings', query: { group: 'execution' } })
  await mount()
  expect(all('.dt-block-title').map(title => title.textContent)).toEqual([zh.globalParameters, zh.taskTypes])
  expect(all('.dt-block')).toHaveLength(2)
  expect(text()).toContain(zh.fallbackHiddenHint)
  // The fallback engine, prepare command, blocked commands and Claude Code / opencode parameters are API-only.
  for (const label of [zh.executorEngine, zh.prepareCommand, zh.blockedCommands, zh.claudeBin, zh.claudeModel,
    zh.claudePermissionMode, zh.claudeApproval, zh.claudeEffort, zh.claudeUltracode, zh.opencodeBin, zh.opencodeModel,
    zh.opencodeAgent, zh.opencodeApproval, zh.opencodePermissionPreset]) expect(hasField(label)).toBe(false)
  // The legacy executor directory shows only while no task type exists.
  expect(hasField(zh.executionDirectory)).toBe(false)
  expect(hasField(zh.directoryMode)).toBe(false)
  server.settings = { ...server.settings, executor: { ...server.settings.executor, taskTypes: [] } }
  await remount()
  expect(hasField(zh.executionDirectory)).toBe(true)
  expect(hasField(zh.directoryMode)).toBe(true)
})

it('picks a per-type engine with an inherit option and re-queries the model catalog on a switch', async () => {
  server.settings = { ...server.settings, executor: { ...server.settings.executor, engine: 'dsh', taskTypes: seededTaskTypes() } }
  server.engineModels = { 'claude-code': { engine: 'claude-code', source: 'builtin', failures: [], default: null,
    groups: [{ id: 'anthropic', name: 'Anthropic', models: [{ id: 'sonnet', name: 'Sonnet' }] }] } }
  at({ page: 'settings', query: { group: 'execution' } })
  await mount()
  const engine = () => field<HTMLSelectElement>(zh.taskTypeEngine)
  expect(engine().value).toBe('')
  expect([...engine().options].map(option => [option.value, option.textContent])).toEqual([
    ['', zh.taskTypeEngineInherit.replace('{engine}', zh['engine.dsh'])], ['dsh', zh['engine.dsh']],
    ['claude-code', zh['engine.claude-code']], ['opencode', zh['engine.opencode']]])
  expect(hasField(zh.taskTypeClaudePermissionMode)).toBe(false)
  // The type's picker lists the executor's catalog at first, then the chosen engine's own routes.
  const picker = () => all('.dt-model')[1]!
  const select = (index: number) => picker().querySelectorAll('select')[index] as HTMLSelectElement
  expect([...select(0).options].map(option => option.value)).toContain('deepseek-account')
  await type(engine(), 'claude-code')
  expect(hasField(zh.taskTypeClaudePermissionMode)).toBe(true)
  expect([...select(0).options].map(option => option.value)).toEqual(['', 'anthropic'])
  await type(select(0), 'anthropic')
  await type(select(1), 'sonnet')
  // Switching the engine clears a model route that belongs to the previous engine.
  await type(engine(), 'dsh')
  expect(hasField(zh.taskTypeClaudePermissionMode)).toBe(false)
  expect(select(1).value).toBe('')
  await click(zh.save)
  expect(server.settings.executor.taskTypes[0]!.engine).toBe('dsh')
  expect(server.settings.executor.taskTypes[0]!.model).toBeNull()
  // Empty selects the inheritance itself, which saves as null rather than an explicit engine.
  await type(engine(), '')
  await click(zh.save)
  expect(server.settings.executor.taskTypes[0]!.engine).toBeNull()
  expect(server.settings.executor.engine).toBe('dsh')
})

it('edits the per-type Claude Code parameters, each inheriting the global fallback until it is set', async () => {
  const types = seededTaskTypes()
  types[0] = { ...types[0]!, engine: 'claude-code' }
  server.settings = { ...server.settings, executor: { ...server.settings.executor,
    claudePermissionMode: 'plan', claudeApproval: 'ask', claudeUltracode: false, taskTypes: types } }
  at({ page: 'settings', query: { group: 'execution' } })
  await mount()
  expect(hasField(zh.taskTypeClaudeModel)).toBe(false)
  expect(hasField(zh.taskTypeClaudeEffort)).toBe(false)
  expect(field<HTMLSelectElement>(zh.taskTypeClaudePermissionMode).options[0]!.textContent)
    .toBe(zh.taskTypeInheritGlobalValue.replace('{value}', zh['claudeMode.plan']))
  expect(field<HTMLSelectElement>(zh.taskTypeClaudeApproval).options[0]!.textContent)
    .toBe(zh.taskTypeInheritGlobalValue.replace('{value}', zh['claudeApproval.ask']))
  expect(field<HTMLSelectElement>(zh.taskTypeClaudeUltracode).options[0]!.textContent)
    .toBe(zh.taskTypeInheritGlobalValue.replace('{value}', zh.taskTypeClaudeOff))
  await type(field<HTMLSelectElement>(zh.taskTypeClaudePermissionMode), 'acceptEdits')
  await type(field<HTMLSelectElement>(zh.taskTypeClaudeApproval), 'deny')
  await type(field<HTMLSelectElement>(zh.taskTypeClaudeUltracode), 'on')
  await click(zh.save)
  expect(server.settings.executor.taskTypes[0]!.claude).toEqual({ permissionMode: 'acceptEdits', approval: 'deny', ultracode: true })
  await remount()
  expect(field<HTMLSelectElement>(zh.taskTypeClaudePermissionMode).value).toBe('acceptEdits')
  // Inheriting every parameter again saves no object at all.
  await type(field<HTMLSelectElement>(zh.taskTypeClaudePermissionMode), '')
  await type(field<HTMLSelectElement>(zh.taskTypeClaudeApproval), '')
  await type(field<HTMLSelectElement>(zh.taskTypeClaudeUltracode), '')
  await click(zh.save)
  expect(server.settings.executor.taskTypes[0]!.claude).toBeNull()
})

it('shows the opencode parameters for the effective opencode engine, each inheriting the global fallback until set', async () => {
  const types = seededTaskTypes()
  types[0] = { ...types[0]!, engine: 'opencode' }
  types[1] = { ...types[1]!, engine: 'claude-code' }
  server.settings = { ...server.settings, executor: { ...server.settings.executor, engine: 'dsh',
    opencodeAgent: 'global-agent', opencodeApproval: 'ask', opencodePermissionPreset: 'safe', taskTypes: types } }
  at({ page: 'settings', query: { group: 'execution' } })
  await mount()
  expect(hasField(zh.taskTypeOpencodeModel)).toBe(false)
  expect(field<HTMLInputElement>(zh.taskTypeOpencodeAgent).placeholder)
    .toBe(zh.taskTypeInheritGlobalValue.replace('{value}', 'global-agent'))
  expect(field<HTMLSelectElement>(zh.taskTypeOpencodeApproval).options[0]!.textContent)
    .toBe(zh.taskTypeInheritGlobalValue.replace('{value}', zh['opencodeApproval.ask']))
  expect(field<HTMLSelectElement>(zh.taskTypeOpencodePermissionPreset).options[0]!.textContent)
    .toBe(zh.taskTypeInheritGlobalValue.replace('{value}', zh['opencodePreset.safe']))
  expect(text()).toContain(zh.taskTypeOpencodePermissionRulesHidden)
  // The section follows the effective engine: another type on Claude Code shows no opencode parameters.
  await type(field<HTMLSelectElement>(zh.taskTypeSelect), '1')
  expect(hasField(zh.taskTypeOpencodeAgent)).toBe(false)
  expect(hasField(zh.taskTypeClaudePermissionMode)).toBe(true)
  await type(field<HTMLSelectElement>(zh.taskTypeSelect), '0')
  await type(field<HTMLInputElement>(zh.taskTypeOpencodeAgent), 'build')
  await type(field<HTMLSelectElement>(zh.taskTypeOpencodeApproval), 'deny')
  await type(field<HTMLSelectElement>(zh.taskTypeOpencodePermissionPreset), 'full')
  await click(zh.save)
  expect(server.settings.executor.taskTypes[0]!.opencode).toEqual({ agent: 'build', approval: 'deny',
    permissionPreset: 'full', permissionRules: null })
  await remount()
  expect(field<HTMLInputElement>(zh.taskTypeOpencodeAgent).value).toBe('build')
  expect(field<HTMLSelectElement>(zh.taskTypeOpencodeApproval).value).toBe('deny')
  // Inheriting every parameter again saves no object at all.
  await type(field<HTMLInputElement>(zh.taskTypeOpencodeAgent), '')
  await type(field<HTMLSelectElement>(zh.taskTypeOpencodeApproval), '')
  await type(field<HTMLSelectElement>(zh.taskTypeOpencodePermissionPreset), '')
  await click(zh.save)
  expect(server.settings.executor.taskTypes[0]!.opencode).toBeNull()
})

it('shows the opencode model routes in the shared picker for the global opencode engine and clears them on a switch', async () => {
  const types = seededTaskTypes()
  server.settings = { ...server.settings, executor: { ...server.settings.executor, engine: 'opencode', taskTypes: types } }
  server.engineModels = { opencode: { engine: 'opencode', source: 'cli', failures: [], default: null,
    groups: [{ id: 'opencode-go', name: 'opencode-go', models: [{ id: 'kimi-k3', name: 'kimi-k3' }] }] } }
  at({ page: 'settings', query: { group: 'execution' } })
  await mount()
  const picker = () => all('.dt-model')[1]!
  const provider = () => picker().querySelectorAll('select')[0] as HTMLSelectElement
  expect([...provider().options].map(option => option.value)).toEqual(['', 'opencode-go'])
  await type(provider(), 'opencode-go')
  await type(picker().querySelectorAll('select')[1] as HTMLSelectElement, 'kimi-k3')
  await click(zh.save)
  expect(server.settings.executor.taskTypes[0]!.model).toEqual({ provider: 'opencode-go', model: 'kimi-k3' })
  // Switching to another engine clears the opencode route in the draft.
  await type(field<HTMLSelectElement>(zh.taskTypeEngine), 'claude-code')
  expect(picker().querySelectorAll('select')[1] as HTMLSelectElement).toBeTruthy()
  expect((picker().querySelectorAll('select')[1] as HTMLSelectElement).value).toBe('')
})

it('inherits or explicitly disables the prepare command per type, and says a fixed type never runs it', async () => {
  server.settings = { ...server.settings, executor: { ...server.settings.executor, prepare: 'global-prep',
    taskTypes: seededTaskTypes() } }
  at({ page: 'settings', query: { group: 'execution' } })
  await mount()
  const prepare = () => field<HTMLTextAreaElement>(zh.taskTypePrepare)
  const container = () => prepare().closest('.dt-field')!
  expect(prepare().value).toBe('')
  expect(container().textContent).toContain(zh.taskTypePrepareInherit.replace('{value}', 'global-prep'))
  expect(container().textContent).toContain(zh.prepareCommandFixed)
  await type(field<HTMLSelectElement>(zh.taskTypeDirectoryMode), 'per-ticket')
  expect(container().textContent).not.toContain(zh.prepareCommandFixed)
  const action = (name: string) => [...container().querySelectorAll('button')].find(button => button.textContent === name)!
  await click(action(zh.taskTypePrepareExplicitNone))
  expect(prepare().value).toBe('')
  expect(container().textContent).toContain(zh.taskTypePrepareNoneHint)
  await click(zh.save)
  expect(server.settings.executor.taskTypes[0]!.prepare).toBe('')
  await type(prepare(), 'npm ci')
  expect(prepare().value).toBe('npm ci')
  await click(zh.save)
  expect(server.settings.executor.taskTypes[0]!.prepare).toBe('npm ci')
  // Clearing the box means inherit again, not an explicit empty command.
  await type(prepare(), '')
  expect(container().textContent).toContain(zh.taskTypePrepareInherit.replace('{value}', 'global-prep'))
  await click(zh.save)
  expect(server.settings.executor.taskTypes[0]!.prepare).toBeNull()
})

it('keeps per-type blocked commands as typed until save, with explicit inherit and explicit-none states', async () => {
  server.settings = { ...server.settings, executor: { ...server.settings.executor, blockedCommands: ['global-cli'],
    taskTypes: seededTaskTypes() } }
  at({ page: 'settings', query: { group: 'execution' } })
  await mount()
  const blocked = () => field<HTMLInputElement>(zh.taskTypeBlockedCommands)
  const container = () => blocked().closest('.dt-field')!
  expect(blocked().value).toBe('')
  expect(container().textContent).toContain(zh.taskTypeBlockedCommandsInherit.replace('{value}', 'global-cli'))
  await type(blocked(), 'gh-personal, gh-other')
  expect(blocked().value).toBe('gh-personal, gh-other')
  const action = (name: string) => [...container().querySelectorAll('button')].find(button => button.textContent === name)!
  await click(action(zh.taskTypeBlockedCommandsNoneAction))
  expect(blocked().value).toBe('')
  expect(container().textContent).toContain(zh.taskTypeBlockedCommandsNoneHint)
  await click(zh.save)
  expect(server.settings.executor.taskTypes[0]!.blockedCommands).toEqual([])
  await click(action(zh.taskTypeBlockedCommandsInheritAction))
  expect(container().textContent).toContain(zh.taskTypeBlockedCommandsInherit.replace('{value}', 'global-cli'))
  await click(zh.save)
  expect(server.settings.executor.taskTypes[0]!.blockedCommands).toBeNull()
})

it('saves the hidden global fallback values unchanged and changes only the field the two cards edit', async () => {
  server.settings = { ...server.settings, executor: { ...server.settings.executor, engine: 'claude-code', prepare: 'global-prep',
    blockedCommands: ['global-cli'], claudeBin: '/opt/claude', claudePermissionMode: 'plan',
    claudeApproval: 'ask', claudeUltracode: true, opencodeBin: '/opt/opencode',
    opencodeAgent: 'build', opencodeApproval: 'deny', opencodePermissionPreset: 'full',
    opencodePermissionRules: [{ action: 'shell', resource: 'git push *', effect: 'ask' }], taskTypes: seededTaskTypes() } }
  at({ page: 'settings', query: { group: 'execution' } })
  const before = JSON.parse(JSON.stringify(server.settings.executor)) as Settings['executor']
  await mount()
  await type(field<HTMLInputElement>(zh.maxWorkers), '4')
  await click(zh.save)
  const body = server.requests.find(request => request.method === 'PUT' && request.path === 'settings/executor')!.body as {
    value: Settings['executor'] }
  expect(body.value).toEqual({ ...before, maxWorkers: 4 })
  expect(server.requests.filter(request => request.method === 'PUT').map(request => request.path)).toEqual(['settings/executor'])
  // The saved read-back keeps them too.
  expect(server.settings.executor).toMatchObject({ engine: 'claude-code', prepare: 'global-prep', blockedCommands: ['global-cli'],
    claudeBin: '/opt/claude', claudePermissionMode: 'plan', claudeApproval: 'ask',
    claudeUltracode: true, opencodeBin: '/opt/opencode',
    opencodeAgent: 'build', opencodeApproval: 'deny', opencodePermissionPreset: 'full',
    opencodePermissionRules: [{ action: 'shell', resource: 'git push *', effect: 'ask' }], maxWorkers: 4 })
})

it('words task-type changes in the Execution settings history with localized field names', async () => {
  server.history = { current: 3, policyVersion: 'abcdef1234567890', items: [{ revision: 3, savedAt: '2026-09-22T00:00:00Z',
    source: 'panel', policyVersion: 'abcdef1234567890', policyChanged: false, notified: [], block: 'executor',
    changes: [{ code: 'taskTypeAdded', name: 'Native work' },
      { code: 'taskTypeChanged', name: 'Native work', field: 'engine', from: '', to: 'claude-code' },
      { code: 'taskTypeChanged', name: 'Native work', field: 'blockedCommands', from: '', to: 'type-cli' },
      { code: 'taskTypeRemoved', name: 'Old work' }] }] }
  at({ page: 'settings', query: { group: 'execution' } })
  await mount()
  await click(zh.configHistory)
  expect(text()).toContain('新增任务类型：Native work')
  expect(text()).toContain('任务类型 Native work · 执行引擎：未设置 → Claude Code')
  expect(text()).toContain('任务类型 Native work · 禁止调用的命令：未设置 → type-cli')
  expect(text()).toContain('删除任务类型：Old work')
})

it('keeps what a person types in the legacy Execution settings, converting it once on save', async () => {
  await mount()
  await click(zh['tab.execution'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  const root = () => field<HTMLInputElement>(zh.executionDirectory), workers = () => field<HTMLInputElement>(zh.maxWorkers)
  // A space inside a path and a cleared number stay as typed.
  await type(root(), '/srv/my work ')
  expect(root().value).toBe('/srv/my work ')
  await type(workers(), '')
  expect(workers().value).toBe('')
  await type(workers(), '2')
  await click(zh.save)
  expect(server.requests.find(request => request.path === 'settings/executor')?.body).toMatchObject({ value: { directory: '/srv/my work ', maxWorkers: 2, blockedCommands: ['gh-personal'] } })
  expect(server.settings.executor).toMatchObject({ directory: '/srv/my work', blockedCommands: ['gh-personal'], maxWorkers: 2 })
})

it('says why an Input was not delivered on its Ticket\'s page, in either language', async () => {
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, stage: 'person', action: 'delivery', deliveryError: 'feishu: message recalled' }
  at({ page: 'execution', id: 't1' })
  await mount()
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(zh['stage.delivery'])
  expect(document.querySelector('.dt-banner.dt-danger')?.textContent).toBe(`${zh.deliveryFailedPrefix}feishu: message recalled`)
  expect(text()).toContain(zh.inputRetryHint)
  expect(text()).not.toContain(zh.inputWaitingHint)
  expect(document.querySelector('.dt-status-line')?.textContent).toMatch(/9月\d+日/)
  await remount(en)
  expect(document.querySelector('.dt-status-line')?.textContent).toMatch(/Sep \d+/)
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(en['stage.delivery'])
  expect(document.querySelector('.dt-banner.dt-danger')?.textContent).toBe(`${en.deliveryFailedPrefix}feishu: message recalled`)
  expect(text()).toContain(en.inputRetryHint)
})

it('tells a Ticket or Thread that does not exist from a dsh-superagent that is not answering', async () => {
  at({ page: 'execution', id: 't9' })
  await mount()
  expect(text()).toContain(zh.ticketNotFound)
  // While dsh-superagent restarts, DSH's web server answers every route with an empty 404.
  at({ page: 'execution', id: 't1' })
  server.down = true
  await remount()
  expect(text()).not.toContain(zh.ticketNotFound)
  expect(text()).toContain(zh.hostNotRunning)
  at({ page: 'trigger', id: 'feishu:oc_1:om_root' })
  await remount()
  expect(text()).not.toContain(zh.threadNotFound)
  expect(text()).toContain(zh.hostNotRunning)
})

it('gives a Ticket a bot\'s message started its basis, marks a Thread it follows for context, and an Input it handed back', async () => {
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, mandate: { ...t1.mandate, strength: 'inferred', basis: { via: 'bot', sender: '评审机器人',
    observation: { mode: 'auto' } } },
  basis: { facts: [{ name: 'sender', value: '评审机器人' }, { name: 'bot' }, { name: 'mode', value: 'auto' }], legacy: false },
  threads: [threadSummary(), { ...threadSummary({ key: 'github:7', title: '#7 相关 Issue' }), context: true }],
  inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'e2', at: '2026-09-22T00:03:00Z', delivered: true, trigger: { id: 'e2',
    actor: { source: 'feishu', id: MEMBER, name: { zh: 'Alice', en: 'Alice' } }, human: true, preview: '顺便加一个页面',
    thread: 'feishu:oc_1:om_root', handback: { reason: 'Asks for a new page', at: '2026-09-22T00:05:00Z' } } }] }
  at({ page: 'execution', id: 't1' })
  await mount()
  const facts = () => all('.dt-kv > div').map(row => [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent])
  expect(facts()).toEqual(expect.arrayContaining([[zh['basis.sender'], '评审机器人'], [zh['basis.bot'], zh.yes], [zh['basis.mode'], zh['mode.auto']]]))
  expect(all('.dt-list .dt-ticket').map(row => row.querySelector('.dt-tag')?.textContent)).toEqual([undefined, zh.contextOnly])
  await click(zh.deliveredInputs.replace('{count}', '1'))
  expect(text()).toContain('已交回评估：Asks for a new page')
  await remount(en)
  expect(facts()).toEqual(expect.arrayContaining([[en['basis.bot'], en.yes]]))
  expect(all('.dt-list .dt-ticket').map(row => row.querySelector('.dt-tag')?.textContent)).toEqual([undefined, en.contextOnly])
  await click(en.deliveredInputs.replace('{count}', '1'))
  expect(text()).toContain('Handed back for an Eval: Asks for a new page')
})

it('words an ended Ticket by its outcome, on its row and its page, with a person\'s reason after it', async () => {
  const fields = { id: 't3', title: '已合并的工单', state: 'ended' as const, actions: { retry: false, stop: false },
    ended: { at: '2026-09-21T00:00:00Z', by: 'executor' as const, outcome: 'merged' as const } }
  server.tickets.ended = [ticketSummary(fields, { stage: 'ended' }), ...server.tickets.ended]
  server.ticketDetails.t3 = { ...server.ticketDetails.t1!, ...fields, stage: 'ended' }
  await mount()
  await click(zh['tab.execution'])
  await click(zh['ticket.ended'])
  expect(all('.dt-ticket-stage').map(stage => stage.textContent)).toEqual([zh['outcome.merged'], zh['outcome.stopped']])
  await click('已合并的工单')
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(zh['outcome.merged'])
  expect(text()).toContain(zh['outcome.merged'])
  expect(text()).not.toContain('执行器结束')
  server.ticketDetails.t3 = { ...server.ticketDetails.t3, ended: { at: '2026-09-21T00:00:00Z', by: 'human', outcome: 'stopped',
    reason: '不需要了' } }
  await remount(en)
  expect(all('.dt-hint').map(hint => hint.textContent).find(line => line?.includes(en['outcome.stopped']))).toMatch(/Stopped by a person: 不需要了$/)
})

it('sends one stop for a double click on Confirm', async () => {
  at({ page: 'execution', id: 't1' })
  await mount()
  await click(zh.stop)
  const confirm = find(zh.confirm)
  await act(async () => { confirm.click(); confirm.click() })
  expect(server.requests.filter(request => request.path === 'tickets/t1/stop')).toHaveLength(1)
})
