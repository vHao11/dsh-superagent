/** Execution status view (active Tickets and pause control) and Execution settings group (Executor capacity and workspace environment). */
import { useRef, useState } from 'react'
import { TICKET_FILTERS, type TicketFilter } from '../app/api.ts'
import { LIMITS } from '../limits.ts'
import { usePoll, type SettingsView, type SourceView, type StateView } from './api.ts'
import { Button, DisclosureRow, Icon, InfoTip, Input, Pill } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { usePanel } from './provider.tsx'
import { TicketLine } from './rows.tsx'
import { ConfigHistory, Field, Fields, ModelField, numberOf, SwitchRow, useBlockDraft, useSettings } from './settings-kit.tsx'
import { localized } from './text.ts'
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
type TaskTypeDraft = SettingsView['blocks']['executor']['value']['taskTypes'][number]
const linesOf = (text: string): string[] => text.split('\n').map(line => line.trim()).filter(Boolean)
/** A new type takes the first free generated id, so adding one after a removal never collides with an existing type. */
function blankTaskType(taskTypes: TaskTypeDraft[]): TaskTypeDraft {
  let serial = taskTypes.length + 1
  while (taskTypes.some(type => type.id === `custom-${serial}`)) serial++
  return { id: `custom-${serial}`, name: '', description: '', examples: [], not: [], directory: '', model: null,
    directoryMode: 'fixed', instructions: '' }
}
/**
 * Editor for the user-defined task types. The sorter only picks an id; every directory, model and instruction here is
 * resolved by the host, so the panel is the one place these execution profiles are defined. There is no default type:
 * once a type exists, new work must be classified. One dropdown picks the type to edit, so a deployment with many types
 * keeps the others folded instead of one long form.
 */
function TaskTypesEditor({ taskTypes, onChange }: {
  taskTypes: TaskTypeDraft[]; onChange: (next: TaskTypeDraft[]) => void
}) {
  const { t } = usePanel()
  const [selected, setSelected] = useState(0)
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
        <div className="dt-field">
          <span className="dt-field-head"><label>{t('taskTypeModel')}</label><InfoTip text={t('taskTypeModelHint')} /></span>
          <ModelField value={type.model} inherit={t('taskTypeModelInherit')} onChange={model => patch(index, { model })} />
        </div>
        <Field label={t('taskTypeInstructions')}>
          <textarea className="dt-textarea dt-mono" rows={3} maxLength={4000} value={type.instructions}
            onChange={event => patch(index, { instructions: event.target.value })} />
        </Field>
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
      <Hint>{t('environmentPick')}</Hint>
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
  // Keep raw user text (such as separators between blocked commands) in the draft and parse only on save.
  const executor = blocks.executor.value
  const saved = { ...executor, maxWorkers: String(executor.maxWorkers), blockedCommands: executor.blockedCommands.join(' ') }
  const draft = useBlockDraft('executor', saved, blocks.executor.revision,
    value => ({ ...value, maxWorkers: numberOf(value.maxWorkers), blockedCommands: value.blockedCommands.split(/[\s,]+/).filter(Boolean) }))
  const value = draft.value
  const edit = (next: Partial<typeof value>) => draft.edit({ ...value, ...next })
  const prepare = useRef<HTMLTextAreaElement>(null)
  const insert = (key: string) => {
    const field = prepare.current
    const at = field?.selectionStart ?? value.prepare.length, to = field?.selectionEnd ?? at
    edit({ prepare: `${value.prepare.slice(0, at)}"$${key}"${value.prepare.slice(to)}` })
    requestAnimationFrame(() => { field?.focus(); const caret = at + key.length + 3; field?.setSelectionRange(caret, caret) })
  }
  return <div className="dt-form">
    <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
      <Fields disabled={draft.busy}>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('term.executor')}<InfoTip text={t('executorIntro')} /></h2>
          <Section title={t('executorModel')} hint={t('executorModelHint')}><ModelField value={value.model}
            onChange={model => edit({ model })} /></Section>
          <Section title={t('executorEngine')} hint={t('executorEngineHint')}>
            <Field label={t('executorEngine')}>
              <select className="dt-select" value={value.engine} onChange={event => edit({ engine: event.target.value as typeof value.engine })}>
                <option value="dsh">{t('engine.dsh')}</option>
                <option value="claude-code">{t('engine.claude-code')}</option>
              </select>
            </Field>
            {value.engine === 'claude-code' && <>
              <Field label={t('claudeBin')} hint={t('claudeBinHint')}>
                <Input className="dt-mono" value={value.claudeBin} placeholder="claude" spellCheck={false}
                  onChange={event => edit({ claudeBin: event.target.value })} />
              </Field>
              <Field label={t('claudeModel')} hint={t('claudeModelHint')}>
                <Input className="dt-mono" value={value.claudeModel} spellCheck={false}
                  onChange={event => edit({ claudeModel: event.target.value })} />
              </Field>
              <Field label={t('claudePermissionMode')} hint={t('claudePermissionModeHint')}>
                <select className="dt-select" value={value.claudePermissionMode}
                  onChange={event => edit({ claudePermissionMode: event.target.value as typeof value.claudePermissionMode })}>
                  {(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as const).map(mode =>
                    <option key={mode} value={mode}>{t(`claudeMode.${mode}`)}</option>)}
                </select>
              </Field>
              <Field label={t('claudeApproval')} hint={t('claudeApprovalHint')}>
                <select className="dt-select" value={value.claudeApproval}
                  onChange={event => edit({ claudeApproval: event.target.value as typeof value.claudeApproval })}>
                  {(['approve', 'ask', 'deny'] as const).map(choice =>
                    <option key={choice} value={choice}>{t(`claudeApproval.${choice}`)}</option>)}
                </select>
              </Field>
              <Field label={t('claudeEffort')} hint={t('claudeEffortHint')}>
                <select className="dt-select" value={value.claudeEffort}
                  onChange={event => edit({ claudeEffort: event.target.value as typeof value.claudeEffort })}>
                  {(['', 'low', 'medium', 'high', 'xhigh', 'max'] as const).map(level =>
                    <option key={level} value={level}>{t(`claudeEffort.${level || 'default'}`)}</option>)}
                </select>
              </Field>
              <SwitchRow label={t('claudeUltracode')} hint={t('claudeUltracodeHint')} checked={value.claudeUltracode}
                onChange={claudeUltracode => edit({ claudeUltracode })} />
            </>}
          </Section>
          <Field label={t('maxWorkers')} hint={t('maxWorkersHint')}>
            <Input type="number" min={LIMITS.maxWorkers.min} max={LIMITS.maxWorkers.max} required value={value.maxWorkers}
              onChange={event => edit({ maxWorkers: event.target.value })} />
          </Field>
        </div>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('term.environment')}<InfoTip text={t('environmentIntro')} /></h2>
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
          <Field label={t('prepareCommand')} hint={t('prepareCommandHint')} note={value.directoryMode === 'fixed'
            ? t('prepareCommandFixed') : undefined}>
            <textarea ref={prepare} className="dt-textarea dt-mono" rows={3} maxLength={LIMITS.prepareCommand} spellCheck={false}
              placeholder={t('prepareCommandEmpty')} value={value.prepare}
              onChange={event => edit({ prepare: event.target.value })} />
          </Field>
          <EnvironmentVariables groups={environment.variables} sources={sources} onPick={insert} />
          <Field label={t('blockedCommands')} hint={t('blockedCommandsHint')}>
            <Input className="dt-mono" value={value.blockedCommands} placeholder={t('blockedCommandsNone')} spellCheck={false}
              onChange={event => edit({ blockedCommands: event.target.value })} />
          </Field>
        </div>
        <TaskTypesEditor taskTypes={value.taskTypes} onChange={taskTypes => edit({ taskTypes })} />
      </Fields>
      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
    <ConfigHistory blocks={['executor', 'pause']} />
  </div>
}
