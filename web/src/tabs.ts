/**
 * The tab band: Inbox is pinned; every session opened in this browser gets a
 * closable tab beside it. Per workspace, per browser — a tab is where *you*
 * are, not a property of the session — so it lives in localStorage, not the
 * server.
 */
import { useCallback, useEffect, useState } from 'react'
import type { RailSection } from './components/Rail.js'

const key = (workspaceId: string) => `triage.tabs.${workspaceId || 'default'}`

/**
 * The peek slot: the one document you opened without committing to it. The
 * title rides along so a cold load can label the tab before its store is
 * back — `''` means "we never learned one", and the band shows a generic.
 */
export type Preview = { key: string; title: string }

type Band = { tabs: string[]; preview: Preview | null }

const EMPTY: Band = { tabs: [], preview: null }
const isStr = (x: unknown): x is string => typeof x === 'string'
const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter(isStr) : [])

function read(workspaceId: string): Band {
  try {
    const raw = localStorage.getItem(key(workspaceId))
    const parsed: unknown = raw ? JSON.parse(raw) : null
    // Before the preview slot this was a bare array of tab keys.
    if (Array.isArray(parsed)) return { tabs: strings(parsed), preview: null }
    if (!parsed || typeof parsed !== 'object') return EMPTY
    const o = parsed as Record<string, unknown>
    const p = o.preview as Record<string, unknown> | null | undefined
    return {
      tabs: strings(o.tabs),
      preview: p && isStr(p.key) ? { key: p.key, title: isStr(p.title) ? p.title : '' } : null,
    }
  } catch {
    return EMPTY
  }
}

export function useOpenTabs(workspaceId: string) {
  const [band, setBand] = useState<Band>(() => read(workspaceId))
  const { tabs, preview } = band

  // A workspace switch reloads the page, but stay correct if it ever doesn't.
  useEffect(() => {
    setBand(read(workspaceId))
  }, [workspaceId])

  useEffect(() => {
    try {
      localStorage.setItem(key(workspaceId), JSON.stringify(band))
    } catch {
      // storage full or blocked — tabs are a convenience, not state we need
    }
  }, [band, workspaceId])

  /** Pin a tab. Whatever was being peeked at has now been committed to. */
  const open = useCallback((id: string) => {
    setBand((b) => {
      const tabs = b.tabs.includes(id) ? b.tabs : [...b.tabs, id]
      return { tabs, preview: b.preview?.key === id ? null : b.preview }
    })
  }, [])

  /** Closes a pinned tab or the preview — a key only ever lives in one of them. */
  const close = useCallback((id: string) => {
    setBand((b) => ({ tabs: b.tabs.filter((t) => t !== id), preview: b.preview?.key === id ? null : b.preview }))
  }, [])

  /** A draft tab becoming a session tab: same slot, new key. */
  const replace = useCallback((from: string, to: string) => {
    setBand((b) => {
      const without = b.tabs.filter((t) => t !== to)
      const i = without.indexOf(from)
      const tabs = i === -1 ? (without.includes(to) ? without : [...without, to]) : without.with(i, to)
      return { tabs, preview: b.preview?.key === to ? null : b.preview }
    })
  }, [])

  /**
   * Peek at a document. One slot: opening another replaces it, so browsing
   * never leaves tabs behind. A `null` title means "no better name yet" and
   * keeps the one we already had — the store may still be loading.
   */
  const setPreview = useCallback((key: string, title: string | null) => {
    setBand((b) => {
      if (b.tabs.includes(key)) return b.preview ? { ...b, preview: null } : b
      const same = b.preview?.key === key
      const next = title ?? (same ? (b.preview as Preview).title : '')
      if (same && (b.preview as Preview).title === next) return b
      return { ...b, preview: { key, title: next } }
    })
  }, [])

  return { tabs, preview, open, close, replace, setPreview }
}

/**
 * The last route you were on in each rail section. The rail is *section*
 * navigation: leaving Artifacts for a session and coming back should land on
 * the artifact you were reading, not the grid. Per workspace, per browser —
 * where *you* were, so the same reasoning (and storage) as the tabs above.
 */
const routeKey = (workspaceId: string) => `triage.lastRoute.${workspaceId || 'default'}`

export type LastRoutes = Partial<Record<RailSection, string>>

function readRoutes(workspaceId: string): LastRoutes {
  try {
    const raw = localStorage.getItem(routeKey(workspaceId))
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: LastRoutes = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k as RailSection] = v
    }
    return out
  } catch {
    return {}
  }
}

export function useLastRoutes(workspaceId: string) {
  const [lastRoutes, setLastRoutes] = useState<LastRoutes>(() => readRoutes(workspaceId))

  useEffect(() => {
    setLastRoutes(readRoutes(workspaceId))
  }, [workspaceId])

  useEffect(() => {
    try {
      localStorage.setItem(routeKey(workspaceId), JSON.stringify(lastRoutes))
    } catch {
      // storage full or blocked — rail memory is a convenience, not state we need
    }
  }, [lastRoutes, workspaceId])

  const record = useCallback((section: RailSection, hash: string) => {
    setLastRoutes((prev) => (prev[section] === hash ? prev : { ...prev, [section]: hash }))
  }, [])

  return { lastRoutes, record }
}

/**
 * A stable colour per project folder — the small dot on a tab that says which
 * codebase it belongs to. Derived from the path so it never needs storing.
 */
const PALETTE = ['#3b9eff', '#11ff99', '#ffc53d', '#ff801f', '#ff2047', '#a78bfa', '#f472b6', '#2dd4bf']

export function projectColor(cwd: string): string {
  let h = 0
  for (let i = 0; i < cwd.length; i++) h = (h * 31 + cwd.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}
