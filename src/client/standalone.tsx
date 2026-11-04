/**
 * Standalone page entry: mounts the management `App` into a plain HTML page so it can run outside DSH,
 * inside the bridge iframe that DSH NEXT embeds through its same-origin proxy.
 *
 * Only three host capabilities are replaced:
 * - translation: the built-in `zh` / `en` dictionaries instead of the DSH locale service;
 * - opening a Session: `postMessage` to the parent DSH NEXT panel, which calls `uiWorkspace.openSession`;
 * - management API base: `/orchestrator/api/…` is rewritten to a page-relative path that hits the proxy.
 */
import { createRoot, type Root } from 'react-dom/client'
import { App } from './app.tsx'
import { en, zh, type DshSuperagentKey } from './locales.ts'
import type { T } from './text.ts'

type Dictionary = Record<DshSuperagentKey, string>
const DICTIONARIES: Record<'zh' | 'en', Dictionary> = { zh, en }
const interpolate = (text: string, values?: Record<string, unknown>): string =>
  text.replace(/\{(\w+)\}/g, (match, name: string) => values && name in values ? String(values[name]) : match)

/** Minimal stand-in for the DSH translator: `{name}` interpolation with the key as its own fallback. */
export function translator(lang: 'zh' | 'en'): T {
  const dictionary = DICTIONARIES[lang] ?? DICTIONARIES.zh
  const translate = (key: DshSuperagentKey, values?: Record<string, unknown>): string => {
    const text = dictionary[key]
    return text === undefined ? String(key) : interpolate(text, values)
  }
  return translate as unknown as T
}

/** Rewrite the panel's absolute management-API paths to page-relative ones so they stay inside the proxy. */
function installApiBase(): void {
  const native = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : undefined
    // 页面挂在 <代理前缀>/superagent-bridge/ 下，API 在 <代理前缀>/orchestrator/api/：
    // 向上跳一级走外层代理，代理本身会把它转给 3082。
    if (url !== undefined && url.startsWith('/orchestrator/api/')) return native('../' + url.slice(1), init)
    return native(input, init)
  }
}

export interface StandaloneOptions { lang?: 'zh' | 'en' }

/** Render the panel into `container`; returns the React root for callers that need to unmount it. */
export function mount(container: HTMLElement, options: StandaloneOptions = {}): Root {
  installApiBase()
  const t = translator(options.lang ?? 'zh')
  const openSession = async (sessionId: string): Promise<void> => {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'superagent-bridge:open-session', sessionId }, '*')
    }
  }
  const root = createRoot(container)
  root.render(<App t={t} openSession={openSession} deploymentForm={undefined} />)
  return root
}
