/**
 * Reads the model catalog of one worker engine for the panel's engine-aware model picker: the live DSH provider catalog,
 * the models `opencode` lists on this machine, or the built-in aliases Claude Code accepts. Every engine answers with the
 * same shape, so switching the engine of a task type only swaps the catalog behind the three dropdowns.
 */
import { execFile } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelCatalog, ModelCatalogFailure, ModelCatalogModel, ModelProviderGroup, ModelSelection }
  from '@deepseek-ai/dsh-api-session-controller/types'
import type { EngineName } from '../core/index.ts'
import { resolveOpencodeBin } from '../executor/opencode.ts'

/** How long a native engine may take to list its models before the picker reports the failure. */
const CATALOG_TIMEOUT_MS = 20_000
/** The largest output a CLI model list may produce; a real list is a few kilobytes. */
const CATALOG_MAX_BUFFER = 4 * 1024 * 1024
/** Where an engine's catalog came from, so the panel can say how authoritative it is. */
export type EngineCatalogSource = 'dsh' | 'cli' | 'builtin'
/** The models one worker engine can run, in the shape of the DSH model catalog the panel's picker already renders. */
export interface EngineCatalog {
  readonly engine: EngineName
  readonly groups: readonly ModelProviderGroup[]
  /** The model a Ticket of this engine starts from when none is configured; null leaves it to the engine. */
  readonly default: ModelSelection | null
  /** Providers whose catalog could not be read; the group is absent and the picker still lists the rest. */
  readonly failures: readonly ModelCatalogFailure[]
  readonly source: EngineCatalogSource
  /** Set when the engine's catalog could not be read at all; the picker then falls back to free text. */
  readonly error?: string
}
/** Host dependencies of {@link engineCatalog}. */
export interface EngineCatalogHost {
  /** The DSH context, whose session controller owns the live provider catalog. */
  readonly context: Pick<Context, 'sessionController'>
  /** The executor's configured opencode executable; empty resolves `OPENCODE_BIN` and the install. */
  readonly opencodeBin: () => string
  /** Test seam: run one CLI program and resolve its stdout; defaults to `child_process.execFile`. */
  readonly run?: (command: string, args: readonly string[], timeoutMs: number) => Promise<string>
}
/** Reasoning levels Claude Code's `--effort` accepts; the picker offers them for every Claude model. */
export const CLAUDE_EFFORTS: readonly { id: string; name: string }[] = [
  { id: 'low', name: 'low' }, { id: 'medium', name: 'medium' }, { id: 'high', name: 'high' },
  { id: 'xhigh', name: 'xhigh' }, { id: 'max', name: 'max' },
]
/**
 * The models Claude Code accepts. It does not enumerate them: `--model` takes one of its moving aliases or a full model
 * id, so the catalog lists the aliases with the effort levels they share and leaves the exact ids to the CLI's own default.
 */
export const CLAUDE_CATALOG: readonly ModelProviderGroup[] = [{
  id: 'anthropic',
  name: 'Anthropic (Claude Code)',
  models: [
    { id: 'sonnet', name: 'Sonnet', description: 'Claude Code\'s alias for its current Sonnet model.',
      reasoning: { efforts: CLAUDE_EFFORTS } },
    { id: 'opus', name: 'Opus', description: 'Claude Code\'s alias for its current Opus model.',
      reasoning: { efforts: CLAUDE_EFFORTS } },
    { id: 'haiku', name: 'Haiku', description: 'Claude Code\'s alias for its current Haiku model.',
      reasoning: { efforts: CLAUDE_EFFORTS } },
  ],
}]
/** Run one CLI program and return its stdout, failing with its stderr tail so the panel can show the reason. */
function runCli(command: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: CATALOG_MAX_BUFFER,
      env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: '1' }, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr ?? '').trim() || error.message
        reject(new Error(detail.length > 400 ? `${detail.slice(0, 400)}…` : detail))
        return
      }
      resolve(String(stdout ?? ''))
    })
  })
}
/**
 * Parse `opencode models` output: one `provider/model` per line, optionally with a `#variant` suffix. The provider is
 * everything before the first slash, so a model id that itself contains a slash keeps it; malformed and duplicate lines
 * are dropped rather than failing the whole list.
 */
export function parseOpencodeModels(output: string): ModelProviderGroup[] {
  const groups = new Map<string, ModelCatalogModel[]>()
  for (const line of output.split(/\r?\n/)) {
    const text = line.trim()
    if (!text || text.startsWith('#')) continue
    const slash = text.indexOf('/')
    if (slash <= 0 || slash === text.length - 1) continue
    const provider = text.slice(0, slash), id = text.slice(slash + 1)
    const models = groups.get(provider) ?? []
    if (models.some(model => model.id === id)) continue
    models.push({ id, name: id })
    groups.set(provider, models)
  }
  return [...groups].map(([id, models]) => ({ id, name: id, models }))
}
/** Read the opencode catalog on this machine; a missing or unauthenticated CLI is reported instead of throwing. */
async function opencodeCatalog(host: EngineCatalogHost): Promise<EngineCatalog> {
  const run = host.run ?? runCli
  const bin = resolveOpencodeBin(host.opencodeBin())
  try {
    const groups = parseOpencodeModels(await run(bin, ['models'], CATALOG_TIMEOUT_MS))
    if (!groups.length) return { engine: 'opencode', groups: [], default: null, failures: [], source: 'cli',
      error: `${bin} models listed no models; install opencode 2.2+ and authenticate its providers (opencode auth login)` }
    return { engine: 'opencode', groups, default: null, failures: [], source: 'cli' }
  } catch (error) {
    return { engine: 'opencode', groups: [], default: null, failures: [], source: 'cli',
      error: `${bin} models failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}
/**
 * Read the model catalog of `engine`: the live DSH provider catalog for `dsh`, the machine's `opencode models` for
 * `opencode`, and Claude Code's built-in aliases for `claude-code`. A catalog that cannot be read becomes `error` (with the
 * reason), never an exception, so the panel can show the failure and fall back to free text.
 */
export async function engineCatalog(host: EngineCatalogHost, engine: EngineName): Promise<EngineCatalog> {
  if (engine === 'opencode') return opencodeCatalog(host)
  if (engine === 'claude-code') return { engine, groups: CLAUDE_CATALOG, default: null, failures: [], source: 'builtin' }
  const catalog: ModelCatalog = await host.context.sessionController.modelCatalog()
  return { engine, groups: catalog.groups, default: catalog.default, failures: catalog.failures, source: 'dsh' }
}
