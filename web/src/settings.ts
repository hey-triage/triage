/**
 * The settings modal, as an external store.
 *
 * Any component can open it on a specific tab — a "Fix" link on an auth
 * error opens Claude auth, the workspace menu opens Workspace — without
 * threading callbacks through the tree. The URL form `#/settings/<tab>` maps
 * onto the same call (see App), so a tab is also linkable from outside.
 */
import { useSyncExternalStore } from 'react'

export type SettingsTab = 'workspace' | 'auth' | 'sessions' | 'sources' | 'activity' | 'logs' | 'shortcuts' | 'about'

export const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTab; label: string; sub: string; group: 'workspace' | 'diagnostics' | 'app' }> = [
  { id: 'workspace', label: 'Workspace', sub: 'Name, colour, and which workspace opens by default.', group: 'workspace' },
  { id: 'auth', label: 'Claude auth', sub: 'How this workspace signs in to Claude — and proof that it works.', group: 'workspace' },
  { id: 'sources', label: 'Sources', sub: 'What feeds this inbox: GitHub repos, Slack, and the connectors a session can reach.', group: 'workspace' },
  { id: 'activity', label: 'Activity', sub: 'Recent watch runs in this workspace — what ran, when, and what it filed.', group: 'diagnostics' },
  { id: 'logs', label: 'Logs', sub: 'The daemon’s log, filterable by level and subsystem.', group: 'diagnostics' },
  { id: 'sessions', label: 'Sessions', sub: 'Defaults for every new session started from this browser.', group: 'app' },
  { id: 'shortcuts', label: 'Shortcuts', sub: 'Every key the workbench answers to.', group: 'app' },
  { id: 'about', label: 'About', sub: 'The daemon behind this page: version, ports, and where its data lives.', group: 'app' },
]

export const DEFAULT_SETTINGS_TAB: SettingsTab = 'workspace'

export const isSettingsTab = (v: unknown): v is SettingsTab =>
  typeof v === 'string' && SETTINGS_TABS.some((t) => t.id === v)

/** The hash that opens the modal on a tab: `/#/settings/auth`. */
export const settingsHash = (tab: SettingsTab) => `/settings/${tab}`

type SettingsState = { open: boolean; tab: SettingsTab }

let state: SettingsState = { open: false, tab: DEFAULT_SETTINGS_TAB }
const listeners = new Set<() => void>()

function set(next: SettingsState) {
  state = next
  for (const fn of listeners) fn()
}

export function openSettings(tab: SettingsTab = state.tab) {
  set({ open: true, tab })
}

export function closeSettings() {
  if (state.open) set({ ...state, open: false })
}

export function setSettingsTab(tab: SettingsTab) {
  set({ ...state, tab })
}

export function useSettings(): SettingsState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    () => state,
  )
}
