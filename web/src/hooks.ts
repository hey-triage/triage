import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { store } from './store.js'

export function useConn() {
  return useSyncExternalStore(store.subscribeStructural, store.getConn)
}

export function useSessions() {
  return useSyncExternalStore(store.subscribeStructural, store.getSessions)
}

export function useWorkspaces() {
  return useSyncExternalStore(store.subscribeStructural, store.getWorkspaces)
}

export function useWorkspaceId() {
  return useSyncExternalStore(store.subscribeStructural, store.getWorkspaceId)
}

export function useOnboarded() {
  return useSyncExternalStore(store.subscribeStructural, store.getOnboarded)
}

export function useTerminals() {
  return useSyncExternalStore(store.subscribeStructural, store.getTerminals)
}

export function useEvents(sessionId: string | null) {
  const get = useCallback(() => (sessionId ? store.getEvents(sessionId) : EMPTY), [sessionId])
  return useSyncExternalStore(store.subscribeStructural, get)
}

/**
 * The in-flight assistant line. Backed by the live channel, so a burst of token
 * deltas re-renders this one node once per frame and nothing else.
 */
export function useLiveText(sessionId: string | null) {
  const get = useCallback(() => (sessionId ? store.getLive(sessionId) : ''), [sessionId])
  return useSyncExternalStore(store.subscribeLive, get)
}

export type Route =
  | { page: 'home' }
  | { page: 'session'; id: string }
  | { page: 'inbox' }
  | { page: 'item'; id: string }
  | { page: 'terminal'; id: string }
  | { page: 'terminals' }
  | { page: 'connectors' }
  | { page: 'projects' }
  | { page: 'watches' }

/** The hash for a work item — ids carry `:` `/` `#`, so they travel encoded. */
export const itemHash = (id: string) => `/item/${encodeURIComponent(id)}`

function parseRoute(hash: string): Route {
  if (!hash) return { page: 'home' }
  if (hash === '/inbox') return { page: 'inbox' }
  if (hash.startsWith('/item/')) {
    try {
      return { page: 'item', id: decodeURIComponent(hash.slice('/item/'.length)) }
    } catch {
      return { page: 'inbox' }
    }
  }
  if (hash === '/terminals') return { page: 'terminals' }
  if (hash.startsWith('/terminal/')) return { page: 'terminal', id: hash.slice('/terminal/'.length) }
  if (hash === '/connectors') return { page: 'connectors' }
  if (hash === '/projects') return { page: 'projects' }
  if (hash === '/watches') return { page: 'watches' }
  return { page: 'session', id: hash }
}

/** Route state, kept in the URL hash so `/#<id>` opens a session in its own tab. */
export function useHashRoute(): [Route, (hash: string) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash.slice(1)))
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(location.hash.slice(1)))
    addEventListener('hashchange', onChange)
    return () => removeEventListener('hashchange', onChange)
  }, [])
  const navigate = useCallback((hash: string) => {
    location.hash = hash
    setRoute(parseRoute(hash))
  }, [])
  return [route, navigate]
}

const EMPTY: readonly never[] = []
