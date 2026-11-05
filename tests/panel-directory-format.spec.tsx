// @vitest-environment jsdom
// The Execution settings' Ticket directory accepts Windows absolute paths, not only those starting with `/`.
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { click, field, find, mount, type, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()

it('accepts a Windows Ticket directory instead of demanding a leading slash', async () => {
  await mount()
  await click(zh['tab.execution'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  const directory = () => field<HTMLInputElement>(zh.executionDirectory)
  // A drive path (either separator) and a UNC share are absolute on Windows; the old pattern only allowed `/`.
  for (const value of ['D:\\aiworkspace\\jzjy-workspace-hh', 'D:/aiworkspace/jzjy-workspace-hh', '\\\\server\\share\\work', '/srv/work']) {
    await type(directory(), value)
    expect(directory().validity.patternMismatch, value).toBe(false)
  }
  // A relative path is still refused before the host sees it.
  await type(directory(), 'relative/work')
  expect(directory().validity.patternMismatch).toBe(true)
  await type(directory(), 'D:/aiworkspace/jzjy-workspace-hh')
  await click(zh.save)
  expect(server.requests.find(request => request.path === 'settings/executor')?.body)
    .toMatchObject({ value: { directory: 'D:/aiworkspace/jzjy-workspace-hh' } })
})
