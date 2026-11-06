/** Shared settings context, block draft hook, form controls, Source schema field renderer, and configuration history. */
import { cloneElement, createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement,
  type ReactNode } from 'react'
import type { ApiResponse } from '../app/api.ts'
import type { EngineName } from '../core/index.ts'
import type { FieldSpec, Localized } from '../sources/kind.ts'
import { usePoll, type HistoryView, type Settings, type SettingsView, type SourceView } from './api.ts'
import { Button, DisclosureRow, Icon, InfoTip, Input, SegmentedControl, StateDot, Switch } from './controls.tsx'
import { useDraft } from './draft.tsx'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { settingsRoute } from './route.ts'
import { errorText, localized, valueLabel, when, type T } from './text.ts'
import { Hint, LoadState } from './widgets.tsx'

/** Parse a numeric input string, returning `null` when empty so the server rejects blank required numbers instead of coercing to 0. */
export const numberOf = (text: string): number | null => text.trim() ? Number(text) : null
interface SettingsData { settings: SettingsView; reload: () => Promise<void> }
const SettingsContext = createContext<SettingsData | undefined>(undefined)
export function useSettings(): SettingsData {
  const value = useContext(SettingsContext)
  if (!value) throw new Error('A settings block rendered outside the settings')
  return value
}
export function SettingsProvider({ children }: { children: ReactNode }) {
  const { call } = usePanel()
  const { restarts } = usePanelData()
  const { data, error, reload } = usePoll(() => call('GET settings'), [call, restarts])
  if (!data) return <LoadState error={error} loading />
  return <SettingsContext.Provider value={{ settings: data, reload }}>
    {error && <LoadState error={error} loading={false} />}
    {children}
  </SettingsContext.Provider>
}
export function useBlockDraft<V>(block: string, saved: V, revision: number, toValue: (draft: V) => unknown = draft => draft) {
  const { t, call, notify } = usePanel()
  const { state } = usePanelData()
  const { reload } = useSettings()
  return useDraft({ key: `dsh-superagent/draft/${state?.masterId ?? ''}/${block}`, saved, revision, reload, save: async (value, from) => {
    const result = await call('PUT settings/:block', { block, body: { value: toValue(value), revision: from } })
    notify(t(result.restarting ? 'savedRestarting' : 'saved'))
    return result
  } })
}

/** Fieldset wrapper that restores focus to the previously active input after a save completes and re-enables the form. */
export function Fields({ disabled, children }: { disabled: boolean; children: ReactNode }) {
  const set = useRef<HTMLFieldSetElement>(null)
  const focused = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const active = document.activeElement
    if (disabled) focused.current = active instanceof HTMLElement && set.current?.contains(active) ? active : null
    else if (focused.current && (!active
      || active === document.body)) { focused.current.focus({ preventScroll: true }); focused.current = null }
  }, [disabled])
  return <fieldset ref={set} className="dt-fieldset" disabled={disabled}>{children}</fieldset>
}
export function Field({ label, hint, note,
  children }: { label: string; hint?: string | undefined; note?: ReactNode; children: ReactElement<{ id?: string }> }) {
  const id = useId()
  return <div className="dt-field">
    <span className="dt-field-head"><label htmlFor={id}>{label}</label>{hint && <InfoTip text={hint} />}</span>{cloneElement(children,
      { id })}{note && <small>{note}</small>}
  </div>
}
export function SwitchRow({ label, hint, checked,
  onChange }: { label: string; hint?: string | undefined; checked: boolean; onChange: (next: boolean) => void }) {
  return <div className="dt-switch-row">
    <div className="dt-field-head">{label}{hint && <InfoTip text={hint} />}</div><Switch checked={checked} onChange={onChange}
      label={label} />
  </div>
}
type RoleModel = Settings['eval']['model']
/**
 * The model as three single-line dropdowns, like every other select: the Provider, the models that Provider lists, and
 * the reasoning efforts the chosen model offers. The catalog is the chosen engine's, so switching the engine of a task type
 * asks that engine which routes it supports (with a spinner while the query runs and a notification for its success or
 * failure) and refills the three selects from the answer. A select always lists its whole catalog, so a saved route never
 * hides the other Providers; empty means inherit, and a saved value outside the catalog stays selectable so a custom route
 * survives a catalog change. When the catalog is unavailable the same fields fall back to free text.
 */
export function ModelField({ value, onChange, inherit, engine = 'dsh' }: {
  value: RoleModel; onChange: (next: RoleModel) => void; inherit?: string; engine?: EngineName
}) {
  const { t, call, notify } = usePanel()
  const [catalog, setCatalog] = useState<ApiResponse<'GET engine-models'>>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const engineName = t(`engine.${engine}`)
  // The first catalog load is part of opening the page; only a later one (the user switching the engine) is announced.
  const first = useRef(true), asked = useRef(0)
  useEffect(() => {
    const id = ++asked.current
    const announce = !first.current
    first.current = false
    setLoading(true); setError(undefined)
    call('GET engine-models', { query: { engine } }).then(result => {
      if (asked.current !== id) return
      setCatalog(result); setLoading(false)
      const models = result.groups.reduce((total, group) => total + group.models.length, 0)
      if (result.error) {
        setError(result.error)
        if (announce) notify(t('engineModelsFailed', { engine: engineName, error: result.error }))
      } else if (announce) notify(t('engineModelsLoaded', { engine: engineName, providers: result.groups.length, models }))
    }, failure => {
      if (asked.current !== id) return
      const message = errorText(failure)
      setCatalog(undefined); setError(message); setLoading(false)
      if (announce) notify(t('engineModelsFailed', { engine: engineName, error: message }))
    })
  }, [call, engine, engineName, notify, t])
  const current = { provider: value?.provider ?? '', model: value?.model ?? '', effort: value?.reasoningEffort ?? '' }
  const inheritLabel = inherit ?? t('modelInherit')
  const set = (next: Partial<typeof current>) => {
    const { provider, model, effort } = { ...current, ...next }
    onChange(provider.trim() || model.trim() || effort.trim() ? { provider, model, ...effort ? { reasoningEffort: effort } : {} } : null)
  }
  const groups = catalog?.groups ?? []
  const listed = groups.find(group => group.id === current.provider.trim())?.models ?? []
  const efforts = listed.find(model => model.id === current.model.trim())?.reasoning?.efforts ?? []
  const keepsEffort = (models: readonly { id: string; reasoning?: { efforts: readonly { id: string }[] } }[], model: string): boolean =>
    (models.find(item => item.id === model)?.reasoning?.efforts ?? []).some(item => item.id === current.effort)
  /** Provider and model are one route: another Provider's model is not kept, and a Provider with models takes its first. */
  const chooseProvider = (provider: string) => {
    const models = groups.find(group => group.id === provider)?.models ?? []
    const kept = provider === current.provider.trim() && models.some(item => item.id === current.model.trim())
    const model = kept ? current.model : models[0]?.id ?? ''
    set({ provider, model, effort: keepsEffort(models, model) ? current.effort : '' })
  }
  const chooseModel = (model: string) => set({ model, effort: keepsEffort(listed, model) ? current.effort : '' })
  const fallback = catalog?.default
  const unavailable = !!error || (catalog !== undefined && !groups.length)
  const modelCount = groups.reduce((total, group) => total + group.models.length, 0)
  return <div className="dt-model">
    {loading
      ? <Hint><StateDot state="ongoing" /> {t('engineModelsLoading', { engine: engineName })}</Hint>
      : error
        ? <p className="dt-error">{t('engineModelsError', { engine: engineName, error })}</p>
        : <Hint>{fallback ? t('defaultModel', { model: `${fallback.provider} / ${fallback.model}${fallback.reasoningEffort
          ? ` · ${fallback.reasoningEffort}` : ''}` }) : engine === 'dsh' ? t('defaultModelUnavailable')
          : t('engineModelsCount', { engine: engineName, providers: groups.length, models: modelCount })}</Hint>}
    {catalog?.failures.map(failure => <p key={failure.id} className="dt-error">{t('modelCatalogProviderError', { provider: failure.name || failure.id,
      error: failure.message })}</p>)}
    {unavailable ? <div className="dt-grid3">
      <Field label={t('modelProvider')}><Input spellCheck={false} placeholder={inheritLabel} value={current.provider}
        onChange={event => set({ provider: event.target.value })} /></Field>
      <Field label={t('modelName')}><Input spellCheck={false} placeholder={inheritLabel} value={current.model}
        onChange={event => set({ model: event.target.value })} /></Field>
      <Field label={t('modelEffort')}><Input spellCheck={false} placeholder={t('modelEffortDefault')} value={current.effort}
        onChange={event => set({ effort: event.target.value })} /></Field>
    </div> : <div className="dt-grid3">
      <Field label={t('modelProvider')}>
        <select className="dt-select" value={current.provider} disabled={loading || !groups.length}
          onChange={event => chooseProvider(event.target.value)}>
          <option value="">{inheritLabel}</option>
          {groups.map(group => <option key={group.id} value={group.id}>{group.name || group.id}</option>)}
          {current.provider && !groups.some(group => group.id === current.provider)
            && <option value={current.provider}>{current.provider}</option>}
        </select>
      </Field>
      <Field label={t('modelName')}>
        <select className="dt-select" value={current.model} disabled={loading || !current.provider}
          onChange={event => chooseModel(event.target.value)}>
          {!current.model && <option value="">{current.provider ? t('modelChoose') : inheritLabel}</option>}
          {listed.map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
          {current.model && !listed.some(model => model.id === current.model)
            && <option value={current.model}>{current.model}</option>}
        </select>
      </Field>
      <Field label={t('modelEffort')}>
        <select className="dt-select" value={current.effort} disabled={loading || (!efforts.length && !current.effort)}
          onChange={event => set({ effort: event.target.value })}>
          <option value="">{t('modelEffortDefault')}</option>
          {efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name || effort.id}</option>)}
          {current.effort && !efforts.some(effort => effort.id === current.effort)
            && <option value={current.effort}>{current.effort}</option>}
        </select>
      </Field>
    </div>}
  </div>
}

type HistoryChange = NonNullable<HistoryView['items'][number]['changes']>[number]
function changeText(t: T, change: HistoryChange, sources: SourceView[]): string {
  const source = sources.find(item => item.id === change.source)
  const taskTypeField = change.code === 'taskTypeChanged' ? change.field : undefined
  const field = (change.part ? source?.policy?.fields : source?.fields)?.find(item => item.key === change.field)
  const shown = (value: unknown) => value === undefined || value === null || value === '' ? t('unsetValue') : typeof value === 'boolean'
    ? t(value ? 'yes' : 'no')
    : change.code === 'mode' ? valueLabel(t, 'mode', String(value))
    : taskTypeField === 'engine' ? valueLabel(t, 'engine', String(value))
    : taskTypeField === 'directoryMode' ? valueLabel(t, 'directoryMode', String(value)) : String(value)
  return t(`change.${change.code}`,
    { items: (change.items ?? []).map(item => source?.labels[item] ?? item).join(t('listSeparator')),
    from: shown(change.from), to: shown(change.to), name: change.name ?? '', source: source ? localized(t, source.title)
      : change.source ?? '',
    field: field ? localized(t, field.label) : taskTypeField ? valueLabel(t, 'taskTypeField', taskTypeField) : change.field ?? '' })
}
/**
 * Collapsible revision history for the specified settings blocks, optionally including all Policy-changing saves.
 * Revisions saved before per-block tracking existed have no `block` and appear under `policy`.
 */
export function ConfigHistory({ blocks, versions, focus }: { blocks: string[]; versions?: boolean; focus?: string }) {
  const { t, call } = usePanel()
  const { settings } = useSettings()
  const { sources } = settings
  const [open, setOpen] = useState(!!focus)
  const [data, setData] = useState<HistoryView>()
  const [error, setError] = useState<string>()
  const revisions = JSON.stringify([Object.values(settings.blocks).map(block => block.revision), sources.map(source => source.revision)])
  useEffect(() => { if (open) call('GET policy/history').then(setData, failure => setError(errorText(failure))) }, [open, call, revisions])
  const listed = (block: string | undefined) => block ? blocks.some(item => item === block || (item.endsWith(':')
    && block.startsWith(item))) : blocks.includes('policy')
  const items = data?.items.filter(item => (versions && item.policyChanged) || listed(item.block)) ?? []
  // Match the oldest save that produced the focused Policy version (where that version originated).
  const target = focus ? items.filter(item => item.policyChanged && item.policyVersion.startsWith(focus)).at(-1) : undefined
  const scroll = (element: HTMLLIElement | null) => { if (element
    && !element.dataset.scrolled) { element.dataset.scrolled = '1'; element.scrollIntoView?.({ block: 'center' }) } }
  return <DisclosureRow icon={<Icon name="history" />} title={t('configHistory')} open={open} onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      {error && <p className="dt-error">{error}</p>}
      {data && <>
        <Hint>{t('historyIntro')}</Hint>
        {focus && !target && <Hint>{t('policyVersionUnrecorded', { version: focus.slice(0, 8) })}</Hint>}
        {items.length ? <ul className="dt-timeline">{items.map(item => <li key={item.revision} className={item === target
          ? 'dt-event dt-highlight' : 'dt-event'}
          ref={item === target ? scroll : undefined}>
          <div className="dt-row-title">{t('historyItem', { revision: item.revision, source: valueLabel(t, 'historySource',
            item.source) })}</div>
          <div className="dt-event-foot">{when(item.savedAt, t('lang'))}{item.policyChanged && <> · {t('historyPolicyChanged',
            { version: item.policyVersion.slice(0, 8) })}</>}</div>
          {item.changes === null ? <Hint>{t('historyNoBaseline')}</Hint> : item.changes.length
            ? <ul className="dt-changes">{item.changes.map((change, index) => <li key={index}>{changeText(t, change, sources)}</li>)}</ul>
              : <Hint>{t('historyNoChanges')}</Hint>}
          {item.notified.length > 0 && <Hint>{t('historyNotified', { count: item.notified.length,
            titles: item.notified.map(ticket => ticket.title).join(t('listSeparator')) })}</Hint>}
        </li>)}</ul> : <Hint>{t('historyEmpty')}</Hint>}
      </>}
    </div>
  </DisclosureRow>
}

type Row = Record<string, string>
type Column = Extract<FieldSpec, { type: 'rows' }>['columns'][number]
const ROWS_SHOWN = 6
const byName = ([, a]: [string, string], [, b]: [string, string]) => a.localeCompare(b)
function RowsField({ field, value, saved, onChange, labels, refreshLabels }: {
  field: Extract<FieldSpec, { type: 'rows' }>; value: unknown; saved: unknown; onChange: (next: unknown) => void; labels: Record<string,
    string>
  refreshLabels: (() => Promise<string[]>) | undefined
}) {
  const { t, notify } = usePanel()
  const [open, setOpen] = useState(false)
  const refresh = useAction(async () => {
    try {
      const added = await refreshLabels!()
      notify(added.length ? t('labelsAdded', { names: added.join(t('listSeparator')) }) : t('labelsCurrent'))
    } catch (failure) { notify(t('labelsFailed', { error: errorText(failure) })) }
  })
  const label = localized(t, field.label), hint = localized(t, field.hint)
  const rows = Array.isArray(value) ? value as Row[] : []
  const set = (index: number, row: Row) => onChange(rows.map((item, position) => position === index ? row : item))
  const key = field.columns[0]!
  const savedKeys = new Set((Array.isArray(saved) ? saved as Row[] : []).map(row => row[key.key]))
  const choose = key.type === 'text' && key.choose && Object.keys(labels).length ? localized(t, key.choose) : ''
  // Exclude options already selected in another row.
  const choices = (id: string) => Object.entries(labels).filter(([option]) => option === id
    || !rows.some(other => other[key.key] === option)).sort(byName)
  // Optional columns stay out of a blank row: an empty cell is absence, not an empty value the schema must accept.
  const blank = Object.fromEntries(field.columns.filter(column => column.type !== 'text' || !column.optional).map(column => [column.key, column.type === 'select' ? column.options[0]!.value : '']))
  // Summarize a row by its second column only when that column is free text (e.g., a display name), not a select option.
  const named = field.columns[1]?.type === 'text' ? field.columns[1] : undefined
  const rowName = (row: Row) => (named && row[named.key]) || labels[row[key.key] ?? ''] || row[key.key] || ''
  // Widths are fr units; the last grid track holds the remove button.
  const template = [...field.columns.map(column => `minmax(0, ${column.width ?? 1}fr)`), 'auto'].join(' ')
  const cell = (row: Row, index: number, column: Column) => {
    const id = row[key.key] ?? ''
    const change = (next: string) => {
      const updated = { ...row, [column.key]: next }
      // Clearing an optional cell removes it, so the saved row keeps the schema's optional meaning.
      if (column.type === 'text' && column.optional && next === '') delete updated[column.key]
      set(index, updated)
    }
    if (column === key && (savedKeys.has(id) || (!choose && labels[id]))) {
      return <span key={column.key} className={labels[id] ? 'dt-row-label' : 'dt-row-label dt-mono'} title={id}>{labels[id] ?? id}</span>
    }
    if (column === key && choose) {
      return <select key={column.key} className="dt-select" aria-label={choose} required value={id}
        onChange={event => change(event.target.value)}>
        <option value="" disabled>{choose}</option>
        {choices(id).map(([option, name]) => <option key={option} value={option}>{name}</option>)}
      </select>
    }
    if (column.type === 'select') {
      return <select key={column.key} className="dt-select" aria-label={localized(t, column.label)} value={row[column.key] ?? ''}
        onChange={event => change(event.target.value)}>
        {column.options.map(option => <option key={option.value} value={option.value}>{localized(t, option.label)}</option>)}
      </select>
    }
    if (column.multiline) {
      return <textarea key={column.key} className="dt-textarea dt-rows-textarea" aria-label={localized(t, column.label)}
        placeholder={localized(t, column.label)} required={!column.optional} spellCheck={false} rows={2} value={row[column.key] ?? ''}
        onChange={event => change(event.target.value)} />
    }
    return <Input key={column.key} className={column.optional ? undefined : 'dt-mono'} aria-label={localized(t, column.label)}
      placeholder={localized(t, column.label)}
      required={!column.optional} pattern={column.pattern} spellCheck={false} value={row[column.key] ?? ''}
        onChange={event => change(event.target.value)} />
  }
  return <div className="dt-field">
    <div className="dt-subhead">
      <span className="dt-field-head">{label}{hint && <InfoTip text={hint} />}<span className="dt-count">{rows.length || ''}</span></span>
      <span className="dt-subhead-actions">
        {key.type === 'text' && key.refresh && refreshLabels && <Button variant="ghost" size="sm" className={refresh.busy ? 'dt-btn-busy'
          : undefined} icon={<Icon name="refresh" />}
          disabled={refresh.busy} aria-busy={refresh.busy} onClick={() => { void refresh.run() }}>{localized(t, key.refresh)}</Button>}
        <Button variant="ghost" size="sm" icon={<Icon name="plus" />} onClick={() => { setOpen(true); onChange([...rows,
          blank]) }}>{t('addRow')}</Button>
      </span>
    </div>
    {rows.length > ROWS_SHOWN && <button type="button" className="dt-textlink dt-rows-summary" aria-expanded={open}
      onClick={() => setOpen(!open)}>
      {open ? t('collapse') : rows.map(rowName).join(t('listSeparator'))}
    </button>}
    {(rows.length <= ROWS_SHOWN || open) && <ul className="dt-rows">
      <li className="dt-rows-item dt-rows-head" style={{ gridTemplateColumns: template }} aria-hidden="true">
        {field.columns.map(column => <span key={column.key} className="dt-rows-head-cell">{localized(t, column.label)}</span>)}
        <span />
      </li>
      {rows.map((row, index) => <li key={index} className="dt-rows-item" style={{ gridTemplateColumns: template }}>
      {field.columns.map(column => cell(row, index, column))}
      <Button variant="ghost" size="sm" icon={<Icon name="trash" />} aria-label={t('removeRow', { name: labels[row[key.key] ?? '']
        || row[key.key] || label })}
        onClick={() => onChange(rows.filter((_, position) => position !== index))} />
    </li>)}</ul>}
  </div>
}
export function SourceField({ field, value, saved, fact, onChange, labels, refreshLabels }: {
  field: FieldSpec; value: unknown; saved: unknown; fact: Localized | string | undefined; onChange: (next: unknown) => void
  labels: Record<string, string>
  refreshLabels?: () => Promise<string[]>
}) {
  const { t, navigate } = usePanel()
  const label = localized(t, field.label), hint = localized(t, field.hint)
  switch (field.type) {
    case 'switch': return <SwitchRow label={label} hint={hint} checked={value === true} onChange={onChange} />
    case 'select': return <Field label={label} hint={hint}>
      <SegmentedControl className="dt-segmented dt-field-segmented" label={label} value={String(value ?? field.options[0]!.value)}
        options={field.options.map(option => ({ value: option.value, label: localized(t, option.label) }))} onChange={onChange} />
    </Field>
    case 'number': return <Field label={label} hint={hint}>
      <Input type="number" min={field.min} max={field.max} required value={String(value ?? '')}
        onChange={event => onChange(event.target.value === '' ? '' : Number(event.target.value))} />
    </Field>
    case 'text': return <Field label={label} hint={hint} note={localized(t, fact)}>
      {field.choose && Object.keys(labels).length
        ? <select className="dt-select" value={String(value ?? '')} onChange={event => onChange(event.target.value)}>
          <option value="">{localized(t, field.choose)}</option>
          {value && !labels[String(value)] ? <option value={String(value)}>{String(value)}</option> : null}
          {Object.entries(labels).sort(byName).map(([option, name]) => <option key={option} value={option}>{name}</option>)}
        </select>
        : <Input value={String(value ?? '')} readOnly={field.readonly} pattern={field.pattern} spellCheck={false}
          onChange={event => onChange(event.target.value)} />}
    </Field>
    case 'fact': return <div className="dt-field">
      <span className="dt-field-head">{label}{hint && <InfoTip text={hint} />}</span>
      <span className="dt-mono">{localized(t, fact) || t('empty')}</span>
      {field.settings && <small>
        <button type="button" className="dt-textlink"
          onClick={() => navigate(settingsRoute(field.settings!))}>{t(`openSettingsOf.${field.settings}`)}</button>
      </small>}
    </div>
    case 'rows': return <RowsField field={field} value={value} saved={saved} onChange={onChange} labels={labels}
      refreshLabels={refreshLabels} />
  }
}
