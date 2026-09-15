/**
 * The tab band: Inbox is pinned; every session opened in this browser gets a
 * closable tab beside it. Per workspace, per browser — a tab is where *you*
 * are, not a property of the session — so it lives in localStorage, not the
 * server.
 */
import { useCallback, useEffect, useState } from 'react'
import type { RailSection } from './components/Rail.js'

const key = (workspaceId: string) => `triage.tabs.${workspaceId || 'default'}`

function read(workspaceId: string): string[] {
  try {
    const raw = localStorage.getItem(key(workspaceId))
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function useOpenTabs(workspaceId: string) {
  const [tabs, setTabs] = useState<string[]>(() => read(workspaceId))

  // A workspace switch reloads the page, but stay correct if it ever doesn't.
  useEffect(() => {
    setTabs(read(workspaceId))
  }, [workspaceId])

  useEffect(() => {
    try {
      localStorage.setItem(key(workspaceId), JSON.stringify(tabs))
    } catch {
      // storage full or blocked — tabs are a convenience, not state we need
    }
  }, [tabs, workspaceId])

  const open = useCallback((id: string) => {
    setTabs((prev) => (prev.includes(id) ? prev : [...prev, id]))
  }, [])

  const close = useCallback((id: string) => {
    setTabs((prev) => prev.filter((t) => t !== id))
  }, [])

  /** A draft tab becoming a session tab: same slot, new key. */
  const replace = useCallback((from: string, to: string) => {
    setTabs((prev) => {
      const without = prev.filter((t) => t !== to)
      const i = without.indexOf(from)
      if (i === -1) return without.includes(to) ? without : [...without, to]
      const next = [...without]
      next[i] = to
      return next
    })
  }, [])

  return { tabs, open, close, replace }
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
