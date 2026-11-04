/** Windows path handling: drive-letter configuration, PATHEXT command resolution, and case-insensitive directory comparison. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Config, executable } from '../src/deployment.ts'
import { credentialHelper, sameDirectory } from '../src/infra/environment.ts'

const windows = process.platform === 'win32'
const root = windows ? mkdtempSync(join(tmpdir(), 'windows-paths-')) : ''
afterAll(() => { if (windows) rmSync(root, { recursive: true, force: true }) })

describe.skipIf(!windows)('Windows paths', () => {
  it('accepts a drive-letter state directory and still rejects relative ones', () => {
    const stateDir = join(root, 'state').replaceAll('\\', '/')
    expect(Config({ stateDir }).stateDir).toBe(stateDir)
    expect(() => Config({ stateDir: 'relative/dir' })).toThrow()
    expect(() => Config({ stateDir: '~/state' })).toThrow()
  })

  it('finds a command through PATHEXT, by name or as an absolute path without its extension', () => {
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'tool.CMD'), '@echo off\r\n')
    const slash = (path: string): string => path.replaceAll('\\', '/').toLowerCase()
    const found = executable('tool', bin)
    expect(slash(found)).toBe(slash(join(bin, 'tool.cmd')))
    expect(slash(executable(join(bin, 'tool').replaceAll('\\', '/'), bin))).toBe(slash(found))
  })

  it('compares directories without case and gives git a forward-slash credential helper', () => {
    const directory = join(root, 'State')
    mkdirSync(directory)
    expect(sameDirectory(directory, join(root, 'state'))).toBe(true)
    expect(credentialHelper(join(root, 'bin', 'gh.exe'))).toBe(`!'${join(root, 'bin', 'gh.exe').replaceAll('\\', '/')}' auth git-credential`)
  })
})
