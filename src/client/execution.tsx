/** Execution status view (active Tickets and pause control) and Execution settings (global parameters and per-task-type execution profiles). */
import { cloneElement, useId, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { TICKET_FILTERS, type TicketFilter } from '../app/api.ts'
import { LIMITS } from '../limits.ts'
import { usePoll, type SettingsView, type SourceView, type StateView } from './api.ts'
import { Button, DisclosureRow, Icon, InfoTip, Input, Pill } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { usePanel } from './provider.tsx'
import { TicketLine } from './rows.tsx'
import { ConfigHistory, Field, Fields, ModelField, numberOf, useBlockDraft, useSettings } from './settings-kit.tsx'
import { localized, valueLabel } from './text.ts'
import { ConfirmButton, Hint, LabelValue, LoadMore, LoadState, Section, StatusHead } from './widgets.tsx'

export function ExecutionStatus({ filter: current, taskType, state, reload }: {
  filter: TicketFilter; taskType?: string; state: StateView; reload: () => Promise<void>
}) {
  const { t, call, navigate } = usePanel()
  const [limit, setLimit] = useState(20)
  const { data, error, reload: reloadTickets } = usePoll(() => call('GET tickets', { query: { state: current, limit,
    ...(taskType ? { taskType } : {}) } }), [current, taskType, limit])
  const { paused, load: { maxWorkers } } = state
  // Pausing uses its own block revision so toggling pause does not invalidate an open Execution settings draft.
  const pause = async () => { await call('POST executor/pause', { body: { paused: !paused } }); await reload() }
  const status = state.setup.problem ? { tone: 'warning', label: t('executorWaitingSetup') } : paused ? { tone: 'warning',
    label: t('processingPaused') }
    : { tone: 'ongoing', label: t('executorRunning') }
  const action = paused ? 'resumeProcessing' : 'pauseProcessing'
  // The task-type filter is applied by the host; the route keeps an unfiltered list when no type is chosen.
  const show = (filter: TicketFilter, type = taskType) => { setLimit(20)
    navigate({ page: 'execution', query: { ...(filter === 'open' ? {} : { filter }), ...(type ? { taskType: type } : {}) } }, true) }
  return <>
    <StatusHead hint={t('executionStatusIntro')} settings="execution" />
    <div className="dt-row-meta dt-status-line">
      <span className="dt-status-text" data-state={status.tone}>{status.label}</span>
      {!state.setup.problem && <>
        <LabelValue label={t('executingLabel')}
          value={`${state.load.running} / ${maxWorkers}`} /><LabelValue label={t('queuedLabel')} value={state.load.queued} />
      </>}
      <ConfirmButton variant="outline" icon={paused ? 'play' : 'pause'} label={t(action)} title={t(action)} message={t(paused
        ? 'resumeProcessingConfirm' : 'pauseProcessingConfirm')}
        onConfirm={pause} />
    </div>
    <div className="dt-filters">
      {TICKET_FILTERS.map(value => <Pill key={value} active={current === value}
        onClick={() => show(value)}>{t(`ticketFilter.${value}`)}</Pill>)}
      {state.taskTypes.length > 0 && <label className="dt-row-meta">
        <span className="dt-hint">{t('ticketTypeFilter')}</span>
        <select className="dt-select" aria-label={t('ticketTypeFilter')} value={taskType ?? ''}
          onChange={event => show(current, event.target.value || undefined)}>
          <option value="">{t('ticketTypeAll')}</option>
          {state.taskTypes.map(type => <option key={type.id} value={type.id}>{type.name}</option>)}
        </select>
      </label>}
    </div>
    {current === 'idle' && <Hint>{t('idleHint')}</Hint>}
    <LoadState error={error} loading={!data} />
    {data && (data.items.length ? <ul className="dt-list">{data.items.map(ticket => ticket.stage === 'person'
      ? <TicketLine key={ticket.id} ticket={ticket} question
        onChanged={reloadTickets} /> : <TicketLine key={ticket.id} ticket={ticket} />)}</ul> : <Hint>{t('none')}</Hint>)}
    {data?.next_offset != null && <LoadMore onMore={() => setLimit(limit + 20)} />}
  </>
}

const firstSentence = (text: string): string => /^[^。；;.]*(?:[。；;]|\.(?=\s|$))?/.exec(text)?.[0] ?? text
// The panel's pre-save check for a Ticket directory: a POSIX root, a Windows drive (`D:\…` or `D:/…`) or a UNC share.
// The host validates the path again, so this only rejects obviously wrong shapes before a save is sent.
const ABSOLUTE_DIRECTORY = String.raw`(?:[A-Za-z]:(?:\\|/)|\\\\|/).*`
type ExecutorView = SettingsView['blocks']['executor']['value']
type TaskTypeView = ExecutorView['taskTypes'][number]
type TaskTypeClaude = NonNullable<TaskTypeView['claude']>
type TaskTypeOpencode = NonNullable<TaskTypeView['opencode']>
type EngineName = NonNullable<TaskTypeView['engine']>
type ExecutorFallback = Pick<ExecutorView, 'engine' | 'prepare' | 'blockedCommands' | 'claudeModel' | 'claudePermissionMode'
  | 'claudeApproval' | 'claudeEffort' | 'claudeUltracode' | 'opencodeModel' | 'opencodeAgent' | 'opencodeApproval'
  | 'opencodePermissionPreset'>
/**
 * The task type as the form edits it: `blockedCommands` keeps the raw text (separators included) until save, where `null`
 * means inherit and `''` means an explicitly empty list. Older drafts may still carry the saved array, so both are accepted.
 */
type TaskTypeDraft = Omit<TaskTypeView, 'blockedCommands'> & { blockedCommands: string | string[] | null }
type ExecutorDraft = Omit<ExecutorView, 'maxWorkers' | 'taskTypes'> & { maxWorkers: string; taskTypes: TaskTypeDraft[] }
const ENGINES: readonly EngineName[] = ['dsh', 'claude-code', 'opencode']
const CLAUDE_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as const
const CLAUDE_APPROVALS = ['ask', 'approve', 'deny'] as const
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const CLAUDE_INHERIT: TaskTypeClaude = { model: null, permissionMode: null, approval: null, effort: null, ultracode: null }
const claudeOf = (type: TaskTypeDraft): TaskTypeClaude => ({ ...CLAUDE_INHERIT, ...type.claude })
const OPENCODE_APPROVALS = ['ask', 'approve', 'deny', 'smart'] as const
const OPENCODE_PRESETS = ['smart', 'safe', 'read-only', 'full', 'custom'] as const
// The hidden `permissionRules` stays API-only (Phase 2); an inherited copy survives edits because every control fills the
// object from this value and only replaces its own field.
const OPENCODE_INHERIT: TaskTypeOpencode = { model: null, agent: null, approval: null, permissionPreset: null, permissionRules: null }
const opencodeOf = (type: TaskTypeDraft): TaskTypeOpencode => ({ ...OPENCODE_INHERIT, ...type.opencode })
/** The raw text of a type's blocked commands; a draft from an older version may still hold the saved array. */
const blockedText = (value: TaskTypeDraft['blockedCommands'] | undefined): string =>
  Array.isArray(value) ? value.join(' ') : value ?? ''
/** Parse the typed blocked commands once on save: `null` inherits the executor's fallback and `''` declares none. */
const blockedList = (value: TaskTypeDraft['blockedCommands'] | undefined): string[] | null => value == null ? null
  : Array.isArray(value) ? value : value.trim() ? value.split(/[\s,]+/).filter(Boolean) : []
const linesOf = (text: string): string[] => text.split('\n').map(line => line.trim()).filter(Boolean)
/** A new type takes the first free generated id, so adding one after a removal never collides with an existing type. */
function blankTaskType(taskTypes: TaskTypeDraft[]): TaskTypeDraft {
  let serial = taskTypes.length + 1
  while (taskTypes.some(type => type.id === `custom-${serial}`)) serial++
  return { id: `custom-${serial}`, name: '', description: '', examples: [], not: [], directory: '', model: null,
    directoryMode: 'fixed', instructions: '', readOnly: false, engine: null, claude: null, opencode: null, prepare: null, blockedCommands: null }
}
/** One control with a label and an inline action row, for fields whose empty value carries a meaning the form must state. */
function TaskField({ label, hint, actions, footer, children }: {
  label: string; hint?: string | undefined; actions?: ReactNode; footer?: ReactNode; children: ReactElement<{ id?: string }>
}) {
  const id = useId()
  return <div className="dt-field">
    <span className="dt-field-head"><label htmlFor={id}>{label}</label>{hint && <InfoTip text={hint} />}</span>
    {cloneElement(children, { id })}
    {actions && <div className="dt-actions">{actions}</div>}
    {footer}
  </div>
}
/**
 * Editor for the user-defined task types. The sorter only picks an id; every directory, model, engine, prepare command,
 * blocked-command declaration and instruction here is resolved by the host, so the panel is the one place these execution
 * profiles are defined. There is no default type: once a type exists, new work must be classified. One dropdown picks the
 * type to edit, so a deployment with many types keeps the others folded instead of one long form.
 */
function TaskTypesEditor({ taskTypes, executor, groups, sources, onChange }: {
  taskTypes: TaskTypeDraft[]; executor: ExecutorFallback; groups: SettingsView['environment']['variables']; sources: SourceView[]
  onChange: (next: TaskTypeDraft[]) => void
}) {
  const { t } = usePanel()
  const [selected, setSelected] = useState(0)
  const prepare = useRef<HTMLTextAreaElement>(null)
  const index = taskTypes.length ? Math.min(selected, taskTypes.length - 1) : -1
  const type = index >= 0 ? taskTypes[index]! : undefined
  const patch = (index: number, next: Partial<TaskTypeDraft>) => {
    onChange(taskTypes.map((type, at) => at === index ? { ...type, ...next } : type))
  }
  const remove = (index: number) => {
    const next = taskTypes.filter((_type, at) => at !== index)
    onChange(next)
    setSelected(index < selected ? Math.max(0, selected - 1) : Math.min(selected, next.length - 1))
  }
  const add = () => {
    onChange([...taskTypes, blankTaskType(taskTypes)])
    setSelected(taskTypes.length)
  }
  // Editing one Claude Code parameter fills the others with their inherit (null) value, and drops the object when all
  // parameters are inherited again.
  const patchClaude = (index: number, next: Partial<TaskTypeClaude>) => {
    const claude = { ...claudeOf(taskTypes[index]!), ...next }
    patch(index, { claude: Object.values(claude).every(value => value === null) ? null : claude })
  }
  // The same inherited-object rule for the opencode parameters; the hidden permission rules ride along untouched.
  const patchOpencode = (index: number, next: Partial<TaskTypeOpencode>) => {
    const opencode = { ...opencodeOf(taskTypes[index]!), ...next }
    patch(index, { opencode: Object.values(opencode).every(value => value === null) ? null : opencode })
  }
  const insert = (key: string) => {
    if (!type) return
    const field = prepare.current
    const text = type.prepare ?? ''
    const at = field?.selectionStart ?? text.length, to = field?.selectionEnd ?? at
    patch(index, { prepare: `${text.slice(0, at)}"$${key}"${text.slice(to)}` })
    requestAnimationFrame(() => { field?.focus(); const caret = at + key.length + 3; field?.setSelectionRange(caret, caret) })
  }
  const claude = type ? claudeOf(type) : CLAUDE_INHERIT
  const opencode = type ? opencodeOf(type) : OPENCODE_INHERIT
  const engine = type ? type.engine ?? executor.engine : executor.engine
  const prepareValue = type?.prepare ?? null
  const prepareHint = prepareValue === null ? executor.prepare ? t('taskTypePrepareInherit', { value: executor.prepare })
    : t('taskTypePrepareInheritNone') : prepareValue === '' ? t('taskTypePrepareNoneHint') : ''
  const declared = type?.blockedCommands
  const blockedHint = declared == null ? executor.blockedCommands.length
    ? t('taskTypeBlockedCommandsInherit', { value: executor.blockedCommands.join(' ') })
    : t('taskTypeBlockedCommandsInheritNone')
    : (Array.isArray(declared) ? declared.length === 0 : declared === '') ? t('taskTypeBlockedCommandsNoneHint') : ''
  const inheritValue = (value: string): string => t('taskTypeInheritGlobalValue', { value })
  return <div className="dt-form dt-block">
    <h2 className="dt-block-title">{t('taskTypes')}<InfoTip text={t('taskTypesHint')} /></h2>
    <Hint>{t('taskTypesRule')}</Hint>
    {type ? <>
      <div className="dt-field">
        <div className="dt-subhead">
          <span className="dt-field-head">{t('taskTypeSelect')}</span>
          <span className="dt-subhead-actions">
            <Button variant="ghost" size="sm" icon={<Icon name="plus" />} onClick={add}>{t('taskTypeAdd')}</Button>
            <ConfirmButton variant="ghost" icon="trash" label={t('taskTypeRemove')} title={t('taskTypeRemoveTitle')}
              message={t('taskTypeRemoveConfirm', { name: type.name || type.id || t('empty') })}
              onConfirm={async () => { remove(index) }} />
          </span>
        </div>
        <select className="dt-select" aria-label={t('taskTypeSelect')} value={String(index)}
          onChange={event => setSelected(Number(event.target.value))}>
          {taskTypes.map((item, at) => <option key={at} value={at}>{item.name || item.id || t('empty')}</option>)}
        </select>
      </div>
      <div className="dt-form">
        <div className="dt-grid3">
          <Field label={t('taskTypeId')}>
            <Input className="dt-mono" value={type.id} placeholder={t('taskTypeIdPlaceholder')} spellCheck={false}
              onChange={event => patch(index, { id: event.target.value })} />
          </Field>
          <Field label={t('taskTypeName')}>
            <Input value={type.name} placeholder={t('taskTypeNamePlaceholder')} onChange={event => patch(index, { name: event.target.value })} />
          </Field>
        </div>
        <Field label={t('taskTypeDescription')}>
          <textarea className="dt-textarea" rows={2} maxLength={1000} value={type.description}
            placeholder={t('taskTypeDescriptionPlaceholder')} onChange={event => patch(index, { description: event.target.value })} />
        </Field>
        <div className="dt-grid3">
          <Field label={t('taskTypeExamples')}>
            <textarea className="dt-textarea" rows={2} value={type.examples.join('\n')}
              onChange={event => patch(index, { examples: linesOf(event.target.value) })} />
          </Field>
          <Field label={t('taskTypeNot')}>
            <textarea className="dt-textarea" rows={2} value={type.not.join('\n')}
              onChange={event => patch(index, { not: linesOf(event.target.value) })} />
          </Field>
        </div>
        <div className="dt-grid3">
          <Field label={t('taskTypeDirectory')}>
            <Input className="dt-mono" value={type.directory} spellCheck={false}
              onChange={event => patch(index, { directory: event.target.value })} />
          </Field>
          <Field label={t('taskTypeDirectoryMode')}>
            <select className="dt-select" value={type.directoryMode}
              onChange={event => patch(index, { directoryMode: event.target.value as TaskTypeDraft['directoryMode'] })}>
              {(['fixed', 'per-ticket'] as const).map(mode => <option key={mode} value={mode}>{t(`directoryMode.${mode}`)}</option>)}
            </select>
          </Field>
        </div>
        <Field label={t('taskTypeEngine')} hint={t('taskTypeEngineHint')}>
          <select className="dt-select" value={type.engine ?? ''}
            onChange={event => patch(index, { engine: event.target.value ? event.target.value as EngineName : null })}>
            <option value="">{t('taskTypeEngineInherit', { engine: t(`engine.${executor.engine}`) })}</option>
            {ENGINES.map(name => <option key={name} value={name}>{t(`engine.${name}`)}</option>)}
          </select>
        </Field>
        <div className="dt-field">
          <span className="dt-field-head"><label>{t('taskTypeModel')}</label><InfoTip text={t('taskTypeModelHint')} /></span>
          <ModelField value={type.model} inherit={t('taskTypeModelInherit')} onChange={model => patch(index, { model })} />
        </div>
        <Field label={t('taskTypeInstructions')}>
          <textarea className="dt-textarea dt-mono" rows={3} maxLength={4000} value={type.instructions}
            onChange={event => patch(index, { instructions: event.target.value })} />
        </Field>
        {engine === 'claude-code' && <Section title={t('taskTypeClaude')} hint={t('taskTypeClaudeHint')}>
          <Field label={t('taskTypeClaudeModel')} hint={t('taskTypeClaudeModelHint')}>
            <Input className="dt-mono" value={claude.model ?? ''} spellCheck={false}
              placeholder={inheritValue(executor.claudeModel || t('unsetValue'))}
              onChange={event => patchClaude(index, { model: event.target.value.trim() ? event.target.value : null })} />
          </Field>
          <Field label={t('taskTypeClaudePermissionMode')} hint={t('taskTypeClaudePermissionModeHint')}>
            <select className="dt-select" value={claude.permissionMode ?? ''}
              onChange={event => patchClaude(index, { permissionMode: event.target.value
                ? event.target.value as TaskTypeClaude['permissionMode'] : null })}>
              <option value="">{inheritValue(valueLabel(t, 'claudeMode', executor.claudePermissionMode))}</option>
              {CLAUDE_MODES.map(mode => <option key={mode} value={mode}>{t(`claudeMode.${mode}`)}</option>)}
            </select>
          </Field>
          <Field label={t('taskTypeClaudeApproval')} hint={t('taskTypeClaudeApprovalHint')}>
            <select className="dt-select" value={claude.approval ?? ''}
              onChange={event => patchClaude(index, { approval: event.target.value
                ? event.target.value as TaskTypeClaude['approval'] : null })}>
              <option value="">{inheritValue(valueLabel(t, 'claudeApproval', executor.claudeApproval))}</option>
              {CLAUDE_APPROVALS.map(choice => <option key={choice} value={choice}>{t(`claudeApproval.${choice}`)}</option>)}
            </select>
          </Field>
          <Field label={t('taskTypeClaudeEffort')} hint={t('taskTypeClaudeEffortHint')}>
            <select className="dt-select" value={claude.effort === null ? '' : claude.effort === '' ? 'none' : claude.effort}
              onChange={event => patchClaude(index, { effort: event.target.value === '' ? null
                : event.target.value === 'none' ? '' : event.target.value as TaskTypeClaude['effort'] })}>
              <option value="">{inheritValue(executor.claudeEffort ? valueLabel(t, 'claudeEffort', executor.claudeEffort)
                : t('claudeEffort.default'))}</option>
              <option value="none">{t('claudeEffort.default')}</option>
              {CLAUDE_EFFORTS.map(level => <option key={level} value={level}>{t(`claudeEffort.${level}`)}</option>)}
            </select>
          </Field>
          <Field label={t('taskTypeClaudeUltracode')} hint={t('taskTypeClaudeUltracodeHint')}>
            <select className="dt-select" value={claude.ultracode === null ? '' : claude.ultracode ? 'on' : 'off'}
              onChange={event => patchClaude(index, { ultracode: event.target.value === '' ? null : event.target.value === 'on' })}>
              <option value="">{inheritValue(t(executor.claudeUltracode ? 'taskTypeClaudeOn' : 'taskTypeClaudeOff'))}</option>
              <option value="on">{t('taskTypeClaudeOn')}</option>
              <option value="off">{t('taskTypeClaudeOff')}</option>
            </select>
          </Field>
        </Section>}
        {engine === 'opencode' && <Section title={t('taskTypeOpencode')} hint={t('taskTypeOpencodeHint')}>
          <Field label={t('taskTypeOpencodeModel')} hint={t('taskTypeOpencodeModelHint')}>
            <Input className="dt-mono" value={opencode.model ?? ''} spellCheck={false}
              placeholder={inheritValue(executor.opencodeModel || t('unsetValue'))}
              onChange={event => patchOpencode(index, { model: event.target.value.trim() ? event.target.value : null })} />
          </Field>
          <Field label={t('taskTypeOpencodeAgent')} hint={t('taskTypeOpencodeAgentHint')}>
            <Input className="dt-mono" value={opencode.agent ?? ''} spellCheck={false}
              placeholder={inheritValue(executor.opencodeAgent || t('unsetValue'))}
              onChange={event => patchOpencode(index, { agent: event.target.value.trim() ? event.target.value : null })} />
          </Field>
          <Field label={t('taskTypeOpencodeApproval')} hint={t('taskTypeOpencodeApprovalHint')}>
            <select className="dt-select" value={opencode.approval ?? ''}
              onChange={event => patchOpencode(index, { approval: event.target.value
                ? event.target.value as TaskTypeOpencode['approval'] : null })}>
              <option value="">{inheritValue(valueLabel(t, 'opencodeApproval', executor.opencodeApproval))}</option>
              {OPENCODE_APPROVALS.map(choice => <option key={choice} value={choice}>{t(`opencodeApproval.${choice}`)}</option>)}
            </select>
          </Field>
          <Field label={t('taskTypeOpencodePermissionPreset')} hint={t('taskTypeOpencodePermissionPresetHint')}>
            <select className="dt-select" value={opencode.permissionPreset ?? ''}
              onChange={event => patchOpencode(index, { permissionPreset: event.target.value
                ? event.target.value as TaskTypeOpencode['permissionPreset'] : null })}>
              <option value="">{inheritValue(valueLabel(t, 'opencodePreset', executor.opencodePermissionPreset))}</option>
              {OPENCODE_PRESETS.map(preset => <option key={preset} value={preset}>{t(`opencodePreset.${preset}`)}</option>)}
            </select>
          </Field>
          <Hint>{t('taskTypeOpencodePermissionRulesHidden')}</Hint>
        </Section>}
        <TaskField label={t('taskTypePrepare')} hint={t('prepareCommandHint')}
          actions={<>
            <Button variant="ghost" size="sm" onClick={() => patch(index, { prepare: null })}>{t('taskTypePrepareInheritAction')}</Button>
            <Button variant="ghost" size="sm" onClick={() => patch(index, { prepare: '' })}>{t('taskTypePrepareExplicitNone')}</Button>
          </>}
          footer={<>
            {prepareHint && <Hint>{prepareHint}</Hint>}
            {type.directoryMode === 'fixed' && <small>{t('prepareCommandFixed')}</small>}
          </>}>
          <textarea ref={prepare} className="dt-textarea dt-mono" rows={3} maxLength={LIMITS.prepareCommand} spellCheck={false}
            placeholder={t('prepareCommandEmpty')} value={prepareValue ?? ''}
            onChange={event => patch(index, { prepare: event.target.value === '' ? null : event.target.value })} />
        </TaskField>
        <EnvironmentVariables groups={groups} sources={sources} onPick={insert} />
        <TaskField label={t('taskTypeBlockedCommands')} hint={t('taskTypeBlockedCommandsHint')}
          actions={<>
            <Button variant="ghost" size="sm" onClick={() => patch(index, { blockedCommands: null })}>{t('taskTypeBlockedCommandsInheritAction')}</Button>
            <Button variant="ghost" size="sm" onClick={() => patch(index, { blockedCommands: '' })}>{t('taskTypeBlockedCommandsNoneAction')}</Button>
          </>}
          footer={<>
            {blockedHint && <Hint>{blockedHint}</Hint>}
            <small>{t('blockedCommandsHint')}</small>
          </>}>
          <Input className="dt-mono" value={blockedText(declared)} placeholder={t('blockedCommandsNone')} spellCheck={false}
            onChange={event => patch(index, { blockedCommands: event.target.value === '' ? null : event.target.value })} />
        </TaskField>
      </div>
    </> : <>
      <Hint>{t('taskTypeEmpty')}</Hint>
      <div className="dt-actions">
        <Button variant="ghost" size="sm" icon={<Icon name="plus" />} onClick={add}>{t('taskTypeAdd')}</Button>
      </div>
    </>}
  </div>
}
function EnvironmentVariables({ groups, sources,
  onPick }: { groups: SettingsView['environment']['variables']; sources: SourceView[]; onPick: (key: string) => void }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  const owner = (id: string) => id === 'executor' ? t('term.executor') : localized(t, sources.find(source => source.id === id)?.title ?? id)
  const count = groups.reduce((sum, group) => sum + group.variables.length, 0)
  return <DisclosureRow icon={<Icon name="hash" />} title={<>{t('environmentVariables')} <span className="dt-count">{count}</span></>}
    open={open} onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      <Hint>{t('environmentPick')}<InfoTip text={t('environmentIntro')} /></Hint>
      <table className="dt-table">
        <thead><tr><th>{t('environmentKey')}</th><th>{t('environmentDescription')}</th><th>{t('environmentOwner')}</th></tr></thead>
        <tbody>{groups.flatMap(group => group.variables.map(variable => <tr key={variable.key}>
          <td><button type="button" className="dt-textlink dt-mono" onClick={() => onPick(variable.key)}>{variable.key}</button></td>
          <td title={localized(t, variable.description)}>{firstSentence(localized(t, variable.description))}</td>
          <td>{owner(group.owner)}{!group.enabled && <span className="dt-hint"> · {t('sourceOff')}</span>}</td>
        </tr>))}</tbody>
      </table>
    </div>
  </DisclosureRow>
}
export function ExecutionSettings() {
  const { t } = usePanel()
  const { blocks, environment, sources } = useSettings().settings
  const executor = blocks.executor.value
  // Build the draft from the whole block so the hidden executor fallbacks (engine, prepare, blocked commands, Claude
  // parameters, opencode parameters) survive a save untouched; only the two cards' fields are edited.
  const saved: ExecutorDraft = { ...executor, maxWorkers: String(executor.maxWorkers),
    taskTypes: executor.taskTypes.map(type => ({ ...type, blockedCommands: type.blockedCommands === null ? null
      : type.blockedCommands.join(' ') })) }
  const draft = useBlockDraft('executor', saved, blocks.executor.revision,
    value => ({ ...value, maxWorkers: numberOf(value.maxWorkers),
      taskTypes: value.taskTypes.map(type => ({ ...type, prepare: type.prepare ?? null, blockedCommands: blockedList(type.blockedCommands) })) }))
  const value = draft.value
  const edit = (next: Partial<typeof value>) => draft.edit({ ...value, ...next })
  return <div className="dt-form">
    <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
      <Fields disabled={draft.busy}>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('globalParameters')}<InfoTip text={t('executorIntro')} /></h2>
          <Hint>{t('fallbackHiddenHint')}<InfoTip text={t('executorEngineHint')} /></Hint>
          <Field label={t('maxWorkers')} hint={t('maxWorkersHint')}>
            <Input type="number" min={LIMITS.maxWorkers.min} max={LIMITS.maxWorkers.max} required value={value.maxWorkers}
              onChange={event => edit({ maxWorkers: event.target.value })} />
          </Field>
          <Section title={t('executorModel')} hint={t('executorModelHint')}><ModelField value={value.model}
            onChange={model => edit({ model })} /><Hint>{t('executorModelInheritHint')}</Hint></Section>
          {/* The legacy executor directory applies only before any task type exists; prepare and blocked commands are API-only now. */}
          {value.taskTypes.length === 0 && <>
            <Hint>{t('legacyEnvironmentHint')}</Hint>
            <Field label={t('directoryMode')} hint={t('directoryModeHint')}>
              <select className="dt-select" value={value.directoryMode}
                onChange={event => edit({ directoryMode: event.target.value as typeof value.directoryMode })}>
                {(['per-ticket', 'fixed'] as const).map(mode =>
                  <option key={mode} value={mode}>{t(`directoryMode.${mode}`)}</option>)}
              </select>
            </Field>
            <Field label={t('executionDirectory')} hint={value.directoryMode === 'fixed' ? t('executionDirectoryFixedHint')
              : t('executionDirectoryHint')} note={value.directory ? undefined : t('executionDirectoryDefault', { root: environment.root })}>
              <Input className="dt-mono" value={value.directory} placeholder={t('executionDirectoryEmpty')} spellCheck={false} pattern={ABSOLUTE_DIRECTORY}
                onChange={event => edit({ directory: event.target.value })} />
            </Field>
          </>}
        </div>
        <TaskTypesEditor taskTypes={value.taskTypes} executor={value} groups={environment.variables} sources={sources}
          onChange={taskTypes => edit({ taskTypes })} />
      </Fields>
      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
    <ConfigHistory blocks={['executor', 'pause']} />
  </div>
}
