/**
 * The tab band: Inbox is pinned; every session opened in this browser gets a
 * closable tab beside it. Per workspace, per browser — a tab is where *you*
 * are, not a property of the session — so it lives in localStorage, not the
 * server.
 */
import { useCallback, useEffect, useState } from 'react'

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

  return { tabs, open, close }
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
