/**
 * `@` mentions in a composer: spotting the token under the caret, searching
 * the things it could mean (files under the session folder, work items, other
 * sessions), and holding the picked ones until the message is sent. The kinds
 * are a registry — a new kind is one entry in `SOURCES`, a resolver on the
 * server, and nothing else.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fuzzyRank } from '../../shared/fuzzy.js'
import {
  MAX_MENTIONS_PER_MESSAGE,
  mentionToken,
  type FileSearchResponse,
  type Mention,
  type MentionKind,
  type ScoredItem,
  type SessionSummary,
} from '../../shared/protocol.js'
import { useInbox } from './inboxStore.js'
import { useSessions } from './hooks.js'

// ---------------------------------------------------------------------------
// The token under the caret
// ---------------------------------------------------------------------------

export type ActiveMention = {
  /** index of the `@` */
  start: number
  /** index just past the query (the caret) */
  end: number
  query: string
  /** `item:` / `session:` narrows the picker to one kind; files need no prefix */
  kind: MentionKind | null
}

/**
 * The `@word` the caret sits in, if any. The `@` must start the text or follow
 * whitespace (so an email address is not a mention), and the query runs to the
 * caret without whitespace.
 */
export function activeMention(text: string, caret: number): ActiveMention | null {
  let i = caret - 1
  while (i >= 0 && !/\s/.test(text[i])) {
    if (text[i] === '@') {
      if (i > 0 && !/\s/.test(text[i - 1])) return null
      const raw = text.slice(i + 1, caret)
      // A closed token (`@item:x ` already committed) never reopens — the
      // trailing space ends it, which the loop above already guarantees.
      const m = /^(item|session):(.*)$/.exec(raw)
      if (m) return { start: i, end: caret, query: m[2], kind: m[1] as MentionKind }
      return { start: i, end: caret, query: raw, kind: null }
    }
    i--
  }
  return null
}

/** Replace the active token with the picked mention's token plus a space. */
export function insertMention(text: string, active: ActiveMention, m: Mention): { text: string; caret: number } {
  const token = mentionToken(m) + ' '
  const next = text.slice(0, active.start) + token + text.slice(active.end)
  return { text: next, caret: active.start + token.length }
}

// ---------------------------------------------------------------------------
// Search — one result shape for every kind
// ---------------------------------------------------------------------------

export type MentionHit = Mention & {
  /** the dimmer second line: a folder, a score reason, a session status */
  hint?: string
  /** files only */
  dir?: boolean
}

type Group = { kind: MentionKind; title: string; hits: MentionHit[] }

const GROUP_TITLE: Record<MentionKind, string> = { file: 'Files', item: 'Work items', session: 'Sessions' }

const itemHit = (i: ScoredItem): MentionHit => ({
  kind: 'item',
  ref: i.id,
  label: i.title,
  hint: i.reason,
})

const sessionHit = (s: SessionSummary): MentionHit => ({
  kind: 'session',
  ref: s.id,
  label: s.title,
  hint: `${s.status} · ${s.cwd.split('/').pop() ?? ''}`,
})

const fileHit = (path: string, dir: boolean): MentionHit => {
  const parts = path.replace(/\/$/, '').split('/')
  const name = parts.pop() ?? path
  return { kind: 'file', ref: path, label: dir ? `${name}/` : name, hint: parts.length ? parts.join('/') + '/' : undefined, dir }
}

/**
 * Results for the active token. Items and sessions are already on the client
 * and rank locally; files ask the server for the folder's listing (debounced).
 * With no query, a few of each kind show so the picker teaches what `@` can do.
 */
export function useMentionSearch(active: ActiveMention | null, root: string, exclude: readonly Mention[]) {
  const sessions = useSessions()
  const inbox = useInbox()
  const [files, setFiles] = useState<{ q: string; root: string; hits: MentionHit[]; error?: string }>({
    q: '',
    root: '',
    hits: [],
  })
  const timer = useRef<number | null>(null)

  const query = active?.query ?? ''
  const kind = active?.kind ?? null
  const wantFiles = active !== null && (kind === null || kind === 'file')

  useEffect(() => {
    if (!wantFiles) return
    if (timer.current) window.clearTimeout(timer.current)
    const ctl = new AbortController()
    timer.current = window.setTimeout(() => {
      const url = `/api/files/search?root=${encodeURIComponent(root)}&q=${encodeURIComponent(query)}&limit=${kind === 'file' ? 30 : 12}`
      void fetch(url, { signal: ctl.signal })
        .then((r) => r.json() as Promise<FileSearchResponse>)
        .then((b) => {
          if (b.ok) setFiles({ q: query, root, hits: b.hits.map((h) => fileHit(h.path, h.dir)) })
          else setFiles({ q: query, root, hits: [], error: b.error })
        })
        .catch(() => {})
    }, 60)
    return () => {
      ctl.abort()
    }
  }, [wantFiles, query, root, kind])

  return useMemo<Group[]>(() => {
    if (!active) return []
    const taken = new Set(exclude.map((m) => `${m.kind}:${m.ref}`))
    const keep = (h: MentionHit) => !taken.has(`${h.kind}:${h.ref}`)
    const groups: Group[] = []
    const few = kind === null
    if (kind === null || kind === 'file') {
      // Stale results (an older query, another folder) still show rather than
      // flashing empty; the next response replaces them.
      const hits = files.root === root ? files.hits.filter(keep) : []
      if (hits.length || kind === 'file') groups.push({ kind: 'file', title: GROUP_TITLE.file, hits })
    }
    if (kind === null || kind === 'item') {
      const hits = fuzzyRank(query, inbox.items, (i) => i.title, few ? 4 : 30, 2.5).map(itemHit).filter(keep)
      if (hits.length || kind === 'item') groups.push({ kind: 'item', title: GROUP_TITLE.item, hits })
    }
    if (kind === null || kind === 'session') {
      const chat = sessions.filter((s) => s.kind !== 'watch-run')
      const hits = fuzzyRank(query, chat, (s) => s.title, few ? 4 : 30, 2.5).map(sessionHit).filter(keep)
      if (hits.length || kind === 'session') groups.push({ kind: 'session', title: GROUP_TITLE.session, hits })
    }
    return groups
  }, [active, kind, query, root, files, inbox.items, sessions, exclude])
}

// ---------------------------------------------------------------------------
// The picked mentions, held until send
// ---------------------------------------------------------------------------

export function useMentions() {
  const [mentions, setMentions] = useState<Mention[]>([])

  const add = useCallback((m: Mention) => {
    setMentions((prev) => {
      if (prev.some((p) => p.kind === m.kind && p.ref === m.ref)) return prev
      if (prev.length >= MAX_MENTIONS_PER_MESSAGE) return prev
      return [...prev, { kind: m.kind, ref: m.ref, label: m.label }]
    })
  }, [])

  const remove = useCallback((m: Mention) => {
    setMentions((prev) => prev.filter((p) => !(p.kind === m.kind && p.ref === m.ref)))
  }, [])

  const clear = useCallback(() => setMentions([]), [])

  /**
   * The wire shape: only mentions whose token is still in the text. Deleting
   * `@src/foo.ts` from the message drops the attachment too — the text is the
   * truth, the chips are a mirror.
   */
  const payload = useCallback(
    (text: string): Mention[] | undefined => {
      const kept = mentions.filter((m) => text.includes(mentionToken(m)))
      return kept.length > 0 ? kept : undefined
    },
    [mentions],
  )

  return { mentions, add, remove, clear, payload }
}
