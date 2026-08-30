import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { store } from './store.js'

export function useConn() {
  return useSyncExternalStore(store.subscribeStructural, store.getConn)
}

export function useSessions() {
  return useSyncExternalStore(store.subscribeStructural, store.getSessions)
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
  | { page: 'connectors' }
  | { page: 'projects' }

function parseRoute(hash: string): Route {
  if (!hash) return { page: 'home' }
  if (hash === '/inbox') return { page: 'inbox' }
  if (hash === '/connectors') return { page: 'connectors' }
  if (hash === '/projects') return { page: 'projects' }
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
