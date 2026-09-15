/**
 * One session's changes, fetched once and shared.
 *
 * Both the transcript (per-turn summaries) and the changes drawer (the file
 * list and diffs) read the same payload, so the fetch lives here rather than
 * in either component — one request per turn, not two.
 */
import { useEffect, useState } from 'react'
import type { SessionChanges, SessionChangesResponse } from '../../shared/protocol.js'
import { store } from './store.js'

export function useSessionChanges(sessionId: string | null): SessionChanges | null {
  const [changes, setChanges] = useState<SessionChanges | null>(null)

  useEffect(() => {
    if (!sessionId) {
      setChanges(null)
      return
    }
    let cancelled = false
    const load = () =>
      void fetch(`/api/sessions/${sessionId}/changes`)
        .then((r) => r.json() as Promise<SessionChangesResponse>)
        .then((b) => !cancelled && setChanges(b.ok ? b.changes : null))
        .catch(() => {})

    load()
    // The server pushes when a turn ends, so nothing here polls.
    const off = store.onSessionChanged((id) => id === sessionId && load())
    return () => {
      cancelled = true
      off()
    }
  }, [sessionId])

  return changes
}
