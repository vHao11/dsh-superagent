/** The per-engine model catalog the panel's picker reads: DSH's live providers, opencode's CLI list, Claude's aliases. */
import { describe, expect, it, vi } from 'vitest'
import { CLAUDE_CATALOG, engineCatalog, parseOpencodeModels } from '../src/app/engine-models.ts'

describe('engine model catalogs', () => {
  it('parses one provider/model per line, keeping a nested model id and dropping blanks and duplicates', () => {
    const groups = parseOpencodeModels(['ds/deepseek-flash', 'opencode-go/kimi-k3', 'ds/deepseek-flash', 'badline', '/empty',
      'provider/', '', '# comment', 'openrouter/vendor/model'].join('\n'))
    expect(groups).toEqual([
      { id: 'ds', name: 'ds', models: [{ id: 'deepseek-flash', name: 'deepseek-flash' }] },
      { id: 'opencode-go', name: 'opencode-go', models: [{ id: 'kimi-k3', name: 'kimi-k3' }] },
      { id: 'openrouter', name: 'openrouter', models: [{ id: 'vendor/model', name: 'vendor/model' }] },
    ])
  })
  it('runs `opencode models` and reports a missing or unauthenticated CLI instead of throwing', async () => {
    const run = vi.fn(async () => 'opencode-go/kimi-k3\n')
    const catalog = await engineCatalog({ context: {} as never, opencodeBin: () => '', run }, 'opencode')
    expect(run).toHaveBeenCalledWith(expect.any(String), ['models'], 20_000)
    expect(catalog).toMatchObject({ engine: 'opencode', source: 'cli',
      groups: [{ id: 'opencode-go', models: [{ id: 'kimi-k3' }] }] })
    expect(catalog.error).toBeUndefined()
    const failed = await engineCatalog({ context: {} as never, opencodeBin: () => '', run: async () => { throw new Error('not installed') } },
      'opencode')
    expect(failed.groups).toEqual([])
    expect(failed.error).toContain('not installed')
    const empty = await engineCatalog({ context: {} as never, opencodeBin: () => '', run: async () => '\n' }, 'opencode')
    expect(empty.error).toContain('listed no models')
  })
  it('reads the live DSH catalog for dsh and the built-in aliases for Claude Code', async () => {
    const live = { default: { provider: 'dsh', model: 'm' }, routableProviders: ['dsh'],
      groups: [{ id: 'dsh', name: 'DSH', models: [{ id: 'm', name: 'M' }] }], failures: [{ id: 'x', name: 'X', message: 'down' }] }
    const host = { context: { sessionController: { modelCatalog: async () => live } }, opencodeBin: () => '' }
    expect(await engineCatalog(host as never, 'dsh')).toMatchObject({ engine: 'dsh', groups: live.groups, default: live.default,
      failures: live.failures, source: 'dsh' })
    const claude = await engineCatalog(host as never, 'claude-code')
    expect(claude).toMatchObject({ engine: 'claude-code', groups: CLAUDE_CATALOG, default: null, source: 'builtin' })
    expect(claude.groups.flatMap(group => group.models.map(model => model.id))).toEqual(['sonnet', 'opus', 'haiku'])
  })
})
