import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { waitForStateLock } from '../src/app/runtime.ts'

let roots: string[] = []
const tempState = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-superagent-lock-'))
  roots.push(root)
  return join(root, 'state')
}

/** Leave a lock directory behind the way a killed host does, with an mtime `ageMs` in the past. */
const leaveLock = (stateDir: string, ageMs: number): string => {
  const lock = `${stateDir}.lock`
  mkdirSync(lock, { recursive: true })
  const then = new Date(Date.now() - ageMs)
  utimesSync(lock, then, then)
  return lock
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

describe('waitForStateLock', () => {
  it('takes over the lock a killed process left behind once it is stale', async () => {
    const stateDir = tempState()
    const lock = leaveLock(stateDir, 60_000)
    await waitForStateLock(stateDir, { staleMs: 30_000, timeoutMs: 5_000 })
    // Acquired and released: the next host can take the state directory immediately.
    expect(existsSync(lock)).toBe(false)
  })

  it('gives up with the lock error while a fresh lock is still inside the stale window', async () => {
    const stateDir = tempState()
    leaveLock(stateDir, 0)
    await expect(waitForStateLock(stateDir, { staleMs: 30_000, timeoutMs: 250 })).rejects.toMatchObject({ code: 'ELOCKED' })
  })
})
