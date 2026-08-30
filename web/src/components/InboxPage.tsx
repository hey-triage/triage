import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Group,
  InboxResponse,
  ItemStatus,
  ReposResponse,
  ScoredItem,
  WatchesResponse,
} from '../../../shared/protocol.js'
import { GROUP_LABELS } from '../../../core/work/types.js'
import { anyDialogOpen, isTypingTarget } from '../keys.js'

type LoadState =
  | { phase: 'loading' }
  | { phase: 'ready'; syncedAt: number; items: ScoredItem[]; notices: string[] }
  | { phase: 'error'; message: string }

const GROUP_ORDER: Group[] = ['blocking', 'blocked-stale', 'cycle', 'fyi']

const KIND_LABEL: Record<string, string> = {
  'review-requested': 'review',
  'reply-needed': 'reply',
  'own-pr-approved': 'merge',
  'own-pr-conflicting': 'conflicts',
  'own-pr-stale': 'stale',
  'own-pr-open': 'open PR',
  mention: 'mention',
  'slack-reply-pending': 'slack · reply',
  'slack-mention': 'slack · tag',
  'ticket-assigned': 'ticket',
  'watch-hit': 'watch',
  fyi: 'fyi',
}

export function InboxPage({
  onDispatch,
  onRefineWatch,
}: {
  onDispatch: (item: ScoredItem) => void
  onRefineWatch: (item: ScoredItem) => void
}) {
  const [state, setState] = useState<LoadState>({ phase: 'loading' })
  const [reposOpen, setReposOpen] = useState(false)
  const [repoCount, setRepoCount] = useState<number | null>(null)
  const [watchTitles, setWatchTitles] = useState<Map<string, string>>(new Map())
  const [sel, setSel] = useState(0)

  // done/snoozed/dismissed live in the user-state overlay; the row disappears
  // optimistically and the server recomputes the snapshot on its next sync.
  const setItemState = useCallback(async (item: ScoredItem, status: ItemStatus, snoozeUntil?: number) => {
    setState((prev) =>
      prev.phase === 'ready' ? { ...prev, items: prev.items.filter((i) => i.id !== item.id) } : prev,
    )
    await fetch('/api/items/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: item.id, status, snoozeUntil }),
    }).catch(() => {})
  }, [])

  const snooze1d = useCallback(
    (item: ScoredItem) => {
      const t = new Date()
      t.setDate(t.getDate() + 1)
      t.setHours(9, 0, 0, 0)
      void setItemState(item, 'snoozed', t.getTime())
    },
    [setItemState],
  )

  const load = useCallback(async (refresh: boolean) => {
    setState({ phase: 'loading' })
    try {
      const res = await fetch(`/api/inbox${refresh ? '?refresh=1' : ''}`)
      const body = (await res.json()) as InboxResponse
      if (body.ok) {
        setState({ phase: 'ready', syncedAt: body.syncedAt, items: body.items, notices: body.notices })
      } else {
        setState({ phase: 'error', message: body.error })
      }
    } catch (err) {
      setState({ phase: 'error', message: String(err) })
    }
  }, [])

  // Items in on-screen order (groups are rendered in GROUP_ORDER), so j/k
  // moves through exactly what the eye sees.
  const ordered = useMemo(
    () =>
      state.phase === 'ready'
        ? GROUP_ORDER.flatMap((g) => state.items.filter((i) => i.group === g))
        : [],
    [state],
  )

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(e) || anyDialogOpen() || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        setSel((v) => Math.min(v + 1, Math.max(0, ordered.length - 1)))
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSel((v) => Math.max(v - 1, 0))
      } else if ((e.key === 'o' || e.key === 'Enter') && ordered[sel]) {
        e.preventDefault()
        window.open(ordered[sel].url, '_blank', 'noopener')
      } else if (e.key === 'd' && ordered[sel]) {
        e.preventDefault()
        onDispatch(ordered[sel])
      } else if (e.key === 'e' && ordered[sel]) {
        e.preventDefault()
        void setItemState(ordered[sel], 'done')
      } else if (e.key === 'x' && ordered[sel]) {
        e.preventDefault()
        void setItemState(ordered[sel], 'dismissed')
      } else if (e.key === 'z' && ordered[sel]) {
        e.preventDefault()
        snooze1d(ordered[sel])
      } else if (e.key === 'r') {
        e.preventDefault()
        void load(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [ordered, sel, onDispatch, load, setItemState, snooze1d])

  useEffect(() => {
    void load(false)
    void fetch('/api/repos')
      .then((r) => r.json() as Promise<ReposResponse>)
      .then((b) => {
        if (b.ok) setRepoCount(b.connected.length)
      })
      .catch(() => {})
    void fetch('/api/watches')
      .then((r) => r.json() as Promise<WatchesResponse>)
      .then((b) => {
        if (b.ok) setWatchTitles(new Map(b.watches.map((w) => [w.id, w.title])))
      })
      .catch(() => {})
  }, [load])

  return (
    <div id="inboxPage">
      <div className="inner">
        <div className="pageHead">
          <div>
            <h2>Inbox</h2>
            <p className="sub">
              The work already waiting on you — ranked by who it blocks, not by recency.
            </p>
          </div>
          <button className="refresh repos" onClick={() => setReposOpen(true)}>
            {repoCount == null ? 'Repos' : repoCount === 0 ? 'Repos: all' : `Repos: ${repoCount}`}
          </button>
          <button
            className="refresh"
            disabled={state.phase === 'loading'}
            onClick={() => void load(true)}
          >
            {state.phase === 'loading' ? 'Syncing…' : 'Refresh'}
          </button>
        </div>

        {state.phase === 'loading' && (
          <div className="probing">
            <span className="pip" /> Syncing sources…
          </div>
        )}

        {state.phase === 'error' && <div className="msg error">Sync failed: {state.message}</div>}

        {state.phase === 'ready' && (
          <>
            {state.notices.map((n) => (
              <div key={n} className="notice">
                {n}
              </div>
            ))}
            {state.items.length === 0 ? (
              <div className="inboxEmpty">Inbox zero — nothing is waiting on you.</div>
            ) : (
              GROUP_ORDER.map((g) => (
                <ItemGroup
                  key={g}
                  group={g}
                  items={state.items.filter((i) => i.group === g)}
                  selectedId={ordered[sel]?.id ?? null}
                  watchTitles={watchTitles}
                  onSelect={(id) => setSel(ordered.findIndex((i) => i.id === id))}
                  onDispatch={onDispatch}
                  onDone={(item) => void setItemState(item, 'done')}
                  onRefineWatch={onRefineWatch}
                />
              ))
            )}
            <div className="probedAt">synced {new Date(state.syncedAt).toLocaleTimeString()}</div>
          </>
        )}
      </div>

      <RepoPicker
        open={reposOpen}
        onClose={() => setReposOpen(false)}
        onSaved={(count) => {
          setRepoCount(count)
          setReposOpen(false)
          void load(true) // scope changed — resync now
        }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Repo picker: which repos the GitHub source is scoped to. Empty = all.
// ---------------------------------------------------------------------------

type PickerState =
  | { phase: 'loading' }
  | { phase: 'ready'; available: string[] }
  | { phase: 'error'; message: string }

function RepoPicker({
  open,
  onClose,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  onSaved: (count: number) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [state, setState] = useState<PickerState>({ phase: 'loading' })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (open && !el.open) {
      el.showModal()
      setState({ phase: 'loading' })
      setFilter('')
      void fetch('/api/repos')
        .then((r) => r.json() as Promise<ReposResponse>)
        .then((b) => {
          if (b.ok) {
            // connected repos surface first, and stay listed even if no longer affiliated
            const rest = b.available.filter((r) => !b.connected.includes(r))
            setState({ phase: 'ready', available: [...b.connected, ...rest] })
            setSelected(new Set(b.connected))
          } else {
            setState({ phase: 'error', message: b.error })
          }
        })
        .catch((err) => setState({ phase: 'error', message: String(err) }))
    }
    if (!open && el.open) el.close()
  }, [open])

  const shown = useMemo(() => {
    if (state.phase !== 'ready') return []
    const q = filter.trim().toLowerCase()
    return q ? state.available.filter((r) => r.toLowerCase().includes(q)) : state.available
  }, [state, filter])

  function toggle(repo: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(repo)) next.delete(repo)
      else next.add(repo)
      return next
    })
  }

  async function save() {
    setSaving(true)
    try {
      const repos = [...selected].sort()
      const res = await fetch('/api/repos', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repos }),
      })
      const body = (await res.json()) as ReposResponse
      if (body.ok) onSaved(body.connected.length)
    } finally {
      setSaving(false)
    }
  }

  return (
    <dialog ref={dialog} className="repoDialog" onClose={onClose}>
      <h3>Connected repos</h3>
      <p className="pickerSub">
        The GitHub source only pulls from checked repos. Nothing checked = all repos.
      </p>
      {state.phase === 'loading' && <div className="pickerLoading">Loading your repos…</div>}
      {state.phase === 'error' && <div className="msg error">{state.message}</div>}
      {state.phase === 'ready' && (
        <>
          <input
            className="pickerFilter"
            placeholder="Filter repos…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="pickerList">
            {shown.map((repo) => (
              <label key={repo} className="pickerRow">
                <input type="checkbox" checked={selected.has(repo)} onChange={() => toggle(repo)} />
                <span>{repo}</span>
              </label>
            ))}
            {shown.length === 0 && <div className="pickerLoading">No repos match.</div>}
          </div>
          <div className="pickerCount">
            {selected.size === 0 ? 'all repos' : `${selected.size} selected`}
            {selected.size > 0 && (
              <button className="clearSel" onClick={() => setSelected(new Set())}>
                clear
              </button>
            )}
          </div>
        </>
      )}
      <div className="row">
        <button className="cancel" onClick={onClose}>
          Cancel
        </button>
        <button className="go" disabled={state.phase !== 'ready' || saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </dialog>
  )
}

function ItemGroup({
  group,
  items,
  selectedId,
  watchTitles,
  onSelect,
  onDispatch,
  onDone,
  onRefineWatch,
}: {
  group: Group
  items: ScoredItem[]
  selectedId: string | null
  watchTitles: Map<string, string>
  onSelect: (id: string) => void
  onDispatch: (item: ScoredItem) => void
  onDone: (item: ScoredItem) => void
  onRefineWatch: (item: ScoredItem) => void
}) {
  if (items.length === 0) return null
  return (
    <section className="itemGroup">
      <h3 className={group}>{GROUP_LABELS[group]}</h3>
      <div className="itemList">
        {items.map((item) => (
          <div
            key={item.id}
            className={`itemRow${item.id === selectedId ? ' sel' : ''}`}
            ref={item.id === selectedId ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
            onMouseMove={() => item.id !== selectedId && onSelect(item.id)}
          >
            <span className="itemScore">{Math.round(item.score)}</span>
            <span className={`itemKind ${item.group}`}>{KIND_LABEL[item.kind] ?? item.kind}</span>
            <div className="itemBody">
              <a className="itemTitle" href={item.url} target="_blank" rel="noreferrer">
                {item.returned && <span className="itemReturned" title="Was done — the source updated since">↩ returned</span>}
                {item.title}
              </a>
              <div className="itemMeta">
                <span className="itemRepo">{item.repo}</span> · {item.reason}
                {item.why && <span className="itemWhy"> · “{item.why}”</span>}
                {item.watchId && watchTitles.has(item.watchId) && (
                  <span className="watchChip" title="Matched by this watch">{watchTitles.get(item.watchId)}</span>
                )}
                {item.linked?.map((l) => (
                  <a key={l.url} className="linkedChip" href={l.url} target="_blank" rel="noreferrer" title="Same work, another source">
                    + {l.source} · {l.repo}
                  </a>
                ))}
              </div>
            </div>
            {item.watchId && (
              <button
                className="thumbsDown"
                title="Bad match — refine this watch"
                onClick={() => onRefineWatch(item)}
              >
                👎
              </button>
            )}
            <button className="dispatch done" title="Mark done (e)" onClick={() => onDone(item)}>
              Done
            </button>
            <button
              className="dispatch"
              title="Start a Claude Code session on this item"
              onClick={() => onDispatch(item)}
            >
              Dispatch
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}
