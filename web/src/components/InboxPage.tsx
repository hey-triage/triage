import { Clock, Flag, Folder, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Group,
  InboxResponse,
  ItemEvent,
  ItemEventsResponse,
  ItemListResponse,
  ItemStatus,
  ManualItemResponse,
  Project,
  ProjectsResponse,
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

/** The status tabs (.docs/watches-v2.md): items are durable and never deleted,
 *  so done/snoozed/archived are viewable, not just write-only. */
const TABS = [
  { id: 'open', label: 'Open' },
  { id: 'snoozed', label: 'Snoozed' },
  { id: 'done', label: 'Done' },
  { id: 'archived', label: 'Archived' },
] as const
type Tab = (typeof TABS)[number]['id']

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
  manual: 'task',
  fyi: 'fyi',
}

// Priority, source-derived or a user override (1 urgent … 4 low; 0 = none).
const PRIORITY_LABEL: Record<number, string> = { 0: 'none', 1: 'Urgent', 2: 'High', 3: 'Normal', 4: 'Low' }
const PRIORITY_VALUES = [0, 1, 2, 3, 4]

export function InboxPage({
  onDispatch,
  onRefineWatch,
}: {
  onDispatch: (item: ScoredItem) => void
  onRefineWatch: (item: ScoredItem) => void
}) {
  const [tab, setTab] = useState<Tab>('open')
  const [state, setState] = useState<LoadState>({ phase: 'loading' })
  const [reposOpen, setReposOpen] = useState(false)
  const [repoCount, setRepoCount] = useState<number | null>(null)
  const [watchTitles, setWatchTitles] = useState<Map<string, string>>(new Map())
  const [projects, setProjects] = useState<Project[]>([])
  const [composer, setComposer] = useState<{ open: boolean; editing: ScoredItem | null }>({
    open: false,
    editing: null,
  })
  const [history, setHistory] = useState<ScoredItem | null>(null)
  const [scanning, setScanning] = useState(false)
  const [sel, setSel] = useState(0)

  const scanNow = useCallback(async () => {
    setScanning(true)
    try {
      await fetch('/api/scan', { method: 'POST' }).catch(() => {})
      // give the forced GitHub reconcile a moment, then reload the open tab
      setTimeout(() => void load('open', true), 1200)
    } finally {
      setTimeout(() => setScanning(false), 1200)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const projectName = useCallback(
    (id?: string) => (id ? projects.find((p) => p.id === id)?.name : undefined),
    [projects],
  )

  // A status change is a recorded transition on a durable item — the row leaves
  // the current tab optimistically; the item is never deleted (.docs/watches-v2.md).
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

  // A priority override applies to any item and survives re-sync. Reflect the
  // chip immediately; re-ranking lands on the next refresh.
  const setPriority = useCallback((item: ScoredItem, priority: number) => {
    setState((prev) =>
      prev.phase === 'ready'
        ? {
            ...prev,
            items: prev.items.map((i) =>
              i.id === item.id ? { ...i, priority: priority || undefined } : i,
            ),
          }
        : prev,
    )
    void fetch('/api/items/priority', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: item.id, priority: priority || null }),
    }).catch(() => {})
  }, [])

  // "Delete" a manual item archives it (never a hard delete); it moves to Archived.
  const deleteManual = useCallback((item: ScoredItem) => {
    setState((prev) =>
      prev.phase === 'ready' ? { ...prev, items: prev.items.filter((i) => i.id !== item.id) } : prev,
    )
    void fetch(`/api/items/manual?id=${encodeURIComponent(item.id)}`, { method: 'DELETE' }).catch(() => {})
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

  const load = useCallback(
    async (which: Tab, refresh: boolean) => {
      setState({ phase: 'loading' })
      try {
        if (which === 'open') {
          const res = await fetch(`/api/inbox${refresh ? '?refresh=1' : ''}`)
          const body = (await res.json()) as InboxResponse
          setState(
            body.ok
              ? { phase: 'ready', syncedAt: body.syncedAt, items: body.items, notices: body.notices }
              : { phase: 'error', message: body.error },
          )
        } else {
          const res = await fetch(`/api/items?status=${which}`)
          const body = (await res.json()) as ItemListResponse
          setState(
            body.ok
              ? { phase: 'ready', syncedAt: Date.now(), items: body.items, notices: [] }
              : { phase: 'error', message: body.error },
          )
        }
      } catch (err) {
        setState({ phase: 'error', message: String(err) })
      }
    },
    [],
  )

  const selectTab = useCallback(
    (next: Tab) => {
      setTab(next)
      setSel(0)
      void load(next, false)
    },
    [load],
  )

  // Items in on-screen order. The Open tab renders in GROUP_ORDER; the other
  // tabs are a flat, source-time-ordered list.
  const ordered = useMemo(
    () =>
      state.phase === 'ready'
        ? tab === 'open'
          ? GROUP_ORDER.flatMap((g) => state.items.filter((i) => i.group === g))
          : state.items
        : [],
    [state, tab],
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
      } else if ((e.key === 'o' || e.key === 'Enter') && ordered[sel]?.url) {
        e.preventDefault()
        window.open(ordered[sel].url, '_blank', 'noopener')
      } else if (e.key === 'd' && ordered[sel]) {
        e.preventDefault()
        onDispatch(ordered[sel])
      } else if (e.key === 'e' && ordered[sel]) {
        e.preventDefault()
        void setItemState(ordered[sel], tab === 'open' ? 'done' : 'open')
      } else if (e.key === 'x' && ordered[sel]) {
        e.preventDefault()
        void setItemState(ordered[sel], 'archived')
      } else if (e.key === 'z' && ordered[sel] && tab === 'open') {
        e.preventDefault()
        snooze1d(ordered[sel])
      } else if (e.key === 'n') {
        e.preventDefault()
        setComposer({ open: true, editing: null })
      } else if (e.key === 'r') {
        e.preventDefault()
        void load(tab, true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [ordered, sel, tab, onDispatch, load, setItemState, snooze1d])

  const loadProjects = useCallback(() => {
    void fetch('/api/projects')
      .then((r) => r.json() as Promise<ProjectsResponse>)
      .then((b) => {
        if (b.ok) setProjects(b.projects)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    void load('open', false)
    loadProjects()
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
  }, [load, loadProjects])

  const isOpen = tab === 'open'
  const emptyText = isOpen
    ? state.phase === 'ready' && state.notices.length > 0
      ? 'No open items to show — but a source above is degraded, so this may be incomplete.'
      : 'Inbox zero — nothing is waiting on you.'
    : `Nothing in ${TABS.find((t) => t.id === tab)?.label.toLowerCase()}.`

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
          <button className="refresh add" onClick={() => setComposer({ open: true, editing: null })}>
            + Add item
          </button>
          <button className="refresh repos" onClick={() => setReposOpen(true)}>
            {repoCount == null ? 'Repos' : repoCount === 0 ? 'Repos: all' : `Repos: ${repoCount}`}
          </button>
          <button className="refresh" disabled={scanning} onClick={() => void scanNow()}>
            {scanning ? 'Scanning…' : 'Scan now'}
          </button>
          <button
            className="refresh"
            disabled={state.phase === 'loading'}
            onClick={() => void load(tab, true)}
          >
            {state.phase === 'loading' ? 'Syncing…' : 'Refresh'}
          </button>
        </div>

        <div className="inboxTabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`inboxTab${tab === t.id ? ' active' : ''}`}
              onClick={() => selectTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {state.phase === 'loading' && (
          <div className="probing">
            <span className="pip" /> {isOpen ? 'Syncing sources…' : 'Loading…'}
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
              <div className="inboxEmpty">
                {emptyText}
                {isOpen && (
                  <button className="emptyAdd" onClick={() => setComposer({ open: true, editing: null })}>
                    Add a work item
                  </button>
                )}
              </div>
            ) : isOpen ? (
              GROUP_ORDER.map((g) => (
                <ItemGroup
                  key={g}
                  group={g}
                  items={state.items.filter((i) => i.group === g)}
                  selectedId={ordered[sel]?.id ?? null}
                  watchTitles={watchTitles}
                  projectName={projectName}
                  onSelect={(id) => setSel(ordered.findIndex((i) => i.id === id))}
                  onDispatch={onDispatch}
                  onDone={(item) => void setItemState(item, 'done')}
                  onSnooze={snooze1d}
                  onArchive={(item) => void setItemState(item, 'archived')}
                  onReopen={(item) => void setItemState(item, 'open')}
                  onRefineWatch={onRefineWatch}
                  onSetPriority={setPriority}
                  onEdit={(item) => setComposer({ open: true, editing: item })}
                  onDelete={deleteManual}
                  onHistory={setHistory}
                  tab={tab}
                />
              ))
            ) : (
              <section className="itemGroup">
                <div className="itemList">
                  {state.items.map((item) => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      selected={item.id === (ordered[sel]?.id ?? null)}
                      watchTitles={watchTitles}
                      projectName={projectName}
                      onSelect={(id) => setSel(ordered.findIndex((i) => i.id === id))}
                      onDispatch={onDispatch}
                      onDone={(i) => void setItemState(i, 'done')}
                      onSnooze={snooze1d}
                      onArchive={(i) => void setItemState(i, 'archived')}
                      onReopen={(i) => void setItemState(i, 'open')}
                      onRefineWatch={onRefineWatch}
                      onSetPriority={setPriority}
                      onEdit={(i) => setComposer({ open: true, editing: i })}
                      onDelete={deleteManual}
                      onHistory={setHistory}
                      tab={tab}
                    />
                  ))}
                </div>
              </section>
            )}
            <div className="probedAt">
              {isOpen ? `synced ${new Date(state.syncedAt).toLocaleTimeString()}` : `${state.items.length} item(s)`}
            </div>
          </>
        )}
      </div>

      <RepoPicker
        open={reposOpen}
        onClose={() => setReposOpen(false)}
        onSaved={(count) => {
          setRepoCount(count)
          setReposOpen(false)
          void load(tab, true) // scope changed — resync now
        }}
      />

      <ItemComposer
        open={composer.open}
        editing={composer.editing}
        projects={projects}
        onClose={() => setComposer({ open: false, editing: null })}
        onSaved={() => {
          setComposer({ open: false, editing: null })
          void load(tab, false) // include the new/edited item
        }}
        onSavedMore={() => void load(tab, false)} // "Add more" — refresh, stay open
      />

      <ItemTimeline item={history} watchTitles={watchTitles} onClose={() => setHistory(null)} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Item timeline: the append-only transition log for one item — proof of when it
// was found, by which run, and every state change since (.docs/watches-v2.md).
// ---------------------------------------------------------------------------

const EVENT_LABEL: Record<string, string> = {
  created: 'found',
  updated: 'new activity',
  reopened: 'reopened',
  done: 'marked done',
  archived: 'archived',
  snoozed: 'snoozed',
  woken: 'snooze ended',
}

function actorLabel(actor: string): string {
  if (actor === 'user') return 'you'
  if (actor === 'system') return 'system'
  if (actor === 'agent' || actor.startsWith('agent:')) return 'an agent'
  if (actor.startsWith('watch:')) return 'a watch run'
  return actor
}

function ItemTimeline({
  item,
  watchTitles,
  onClose,
}: {
  item: ScoredItem | null
  watchTitles: Map<string, string>
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [events, setEvents] = useState<ItemEvent[] | null>(null)

  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (item && !el.open) {
      el.showModal()
      setEvents(null)
      void fetch(`/api/items/events?id=${encodeURIComponent(item.id)}`)
        .then((r) => r.json() as Promise<ItemEventsResponse>)
        .then((b) => setEvents(b.ok ? b.events : []))
        .catch(() => setEvents([]))
    }
    if (!item && el.open) el.close()
  }, [item])

  return (
    <dialog ref={dialog} className="itemComposer" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <div className="composerHead">
        <div className="crumbs">
          <span className="crumb">Item</span>
          <span className="crumbSep">›</span>
          <span className="crumb now">Timeline</span>
        </div>
        <button type="button" className="composerClose" onClick={onClose} aria-label="Close">
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      {item && <div className="timelineTitle">{item.title}</div>}
      {events === null ? (
        <div className="pickerLoading">Loading…</div>
      ) : events.length === 0 ? (
        <div className="pickerLoading">No history recorded.</div>
      ) : (
        <ol className="timeline">
          {events.map((ev) => {
            const why = typeof ev.detail?.why === 'string' ? ev.detail.why : undefined
            const reason = typeof ev.detail?.reason === 'string' ? ev.detail.reason : undefined
            const wid = typeof ev.detail?.watchId === 'string' ? ev.detail.watchId : undefined
            return (
              <li key={ev.seq} className="timelineRow">
                <span className={`timelineDot ${ev.event}`} />
                <div>
                  <div className="timelineHead">
                    <b>{EVENT_LABEL[ev.event] ?? ev.event}</b> · {actorLabel(ev.actor)}
                    <span className="timelineWhen">{new Date(ev.at).toLocaleString()}</span>
                  </div>
                  {(why || reason) && <div className="timelineWhy">{why ?? reason}</div>}
                  {wid && watchTitles.has(wid) && <div className="timelineWatch">watch: {watchTitles.get(wid)}</div>}
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </dialog>
  )
}

// ---------------------------------------------------------------------------
// Item composer: add or edit a manual work item (title, project, priority, note).
// ---------------------------------------------------------------------------

function ItemComposer({
  open,
  editing,
  projects,
  onClose,
  onSaved,
  onSavedMore,
}: {
  open: boolean
  editing: ScoredItem | null
  projects: Project[]
  onClose: () => void
  onSaved: () => void
  /** Saved with "Add more" on: refresh the inbox, but keep the composer open. */
  onSavedMore: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleInput = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState('')
  const [projectId, setProjectId] = useState('')
  const [priority, setPriority] = useState(0)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [addMore, setAddMore] = useState(false)

  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (open && !el.open) {
      el.showModal()
      setTitle(editing?.title ?? '')
      setProjectId(editing?.projectId ?? '')
      setPriority(editing?.priority ?? 0)
      setNote(editing?.why ?? '')
      setError(null)
    }
    if (!open && el.open) el.close()
  }, [open, editing])

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const payload = { title, projectId: projectId || undefined, priority, note: note || undefined }
      const path = editing
        ? `/api/items/manual?id=${encodeURIComponent(editing.id)}`
        : '/api/items/manual'
      const res = await fetch(path, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = (await res.json()) as ManualItemResponse
      if (!body.ok) {
        setError(body.error)
      } else if (addMore && !editing) {
        // keep the composer open for the next one; clear all but the project
        onSavedMore()
        setTitle('')
        setNote('')
        setPriority(0)
        setError(null)
        titleInput.current?.focus()
      } else {
        onSaved()
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <dialog ref={dialog} className="itemComposer" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div className="composerHead">
          <div className="crumbs">
            <span className="crumb">Inbox</span>
            <span className="crumbSep">›</span>
            <span className="crumb now">{editing ? 'Edit work item' : 'New work item'}</span>
          </div>
          <button type="button" className="composerClose" onClick={onClose} aria-label="Close">
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <input
          ref={titleInput}
          className="titleInput"
          autoFocus
          placeholder="What needs doing?"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          className="descInput"
          rows={2}
          placeholder="Add context, links, or acceptance criteria…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        <div className="pillRow">
          <label className={`pill prio${priority}`} title="Priority">
            <Flag size={13} aria-hidden="true" />
            <select value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
              {PRIORITY_VALUES.map((v) => (
                <option key={v} value={v}>
                  {v === 0 ? 'Priority' : PRIORITY_LABEL[v]}
                </option>
              ))}
            </select>
          </label>
          <label className={`pill${projectId ? ' set' : ''}`} title="Project">
            <Folder size={13} aria-hidden="true" />
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {error && <div className="msg error">{error}</div>}

        <div className="composerFoot">
          {!editing && (
            <label className="addMore" title="Keep this open to add another after saving">
              <input
                type="checkbox"
                checked={addMore}
                onChange={(e) => setAddMore(e.target.checked)}
              />
              <span className="switch" aria-hidden="true" />
              Add more
            </label>
          )}
          <div className="footActions">
            <button type="button" className="cancel" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="go" disabled={saving || !title.trim()}>
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Add item'}
            </button>
          </div>
        </div>
      </form>
    </dialog>
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

type RowActions = {
  watchTitles: Map<string, string>
  projectName: (id?: string) => string | undefined
  onSelect: (id: string) => void
  onDispatch: (item: ScoredItem) => void
  onDone: (item: ScoredItem) => void
  onSnooze: (item: ScoredItem) => void
  onArchive: (item: ScoredItem) => void
  onReopen: (item: ScoredItem) => void
  onRefineWatch: (item: ScoredItem) => void
  onSetPriority: (item: ScoredItem, priority: number) => void
  onEdit: (item: ScoredItem) => void
  onDelete: (item: ScoredItem) => void
  onHistory: (item: ScoredItem) => void
  tab: Tab
}

function ItemGroup({ group, items, selectedId, ...actions }: { group: Group; items: ScoredItem[]; selectedId: string | null } & RowActions) {
  if (items.length === 0) return null
  return (
    <section className="itemGroup">
      <h3 className={group}>{GROUP_LABELS[group]}</h3>
      <div className="itemList">
        {items.map((item) => (
          <ItemRow key={item.id} item={item} selected={item.id === selectedId} {...actions} />
        ))}
      </div>
    </section>
  )
}

function ItemRow({
  item,
  selected,
  watchTitles,
  projectName,
  onSelect,
  onDispatch,
  onDone,
  onSnooze,
  onArchive,
  onReopen,
  onRefineWatch,
  onSetPriority,
  onEdit,
  onDelete,
  onHistory,
  tab,
}: { item: ScoredItem; selected: boolean } & RowActions) {
  const isManual = item.source === 'manual'
  const isOpen = tab === 'open'
  const proj = projectName(item.projectId)
  const pri = item.priority ?? 0
  // watchId now rides in the provenance list; fall back to the item field.
  const watchId = item.watchId ?? item.foundBy?.[item.foundBy.length - 1]?.watchId
  return (
    <div
      className={`itemRow${selected ? ' sel' : ''}`}
      ref={selected ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
      onMouseMove={() => !selected && onSelect(item.id)}
    >
      <span className="itemScore">{Math.round(item.score)}</span>
      <span className={`itemKind ${item.group}`}>{KIND_LABEL[item.kind] ?? item.kind}</span>
      <div className="itemBody">
        {item.url ? (
          <a className="itemTitle" href={item.url} target="_blank" rel="noreferrer">
            {item.returned && <span className="itemReturned" title="Was done — the source updated since">↩ returned</span>}
            {item.title}
          </a>
        ) : (
          <span className="itemTitle plain">
            {item.returned && <span className="itemReturned" title="Was done — updated since">↩ returned</span>}
            {item.title}
          </span>
        )}
        <div className="itemMeta">
          {item.repo && <><span className="itemRepo">{item.repo}</span> · </>}
          {item.reason}
          {proj && <span className="projChip" title="Project">{proj}</span>}
          {item.why && <span className="itemWhy"> · “{item.why}”</span>}
          {watchId && watchTitles.has(watchId) && (
            <span className="watchChip" title="Matched by this watch">{watchTitles.get(watchId)}</span>
          )}
          {item.linked?.map((l) => (
            <a key={l.url} className="linkedChip" href={l.url} target="_blank" rel="noreferrer" title="Same work, another source">
              + {l.source} · {l.repo}
            </a>
          ))}
        </div>
      </div>
      {isOpen && (
        <select
          className={`prioSelect prio${pri}`}
          title="Set priority"
          value={pri}
          onChange={(e) => onSetPriority(item, Number(e.target.value))}
        >
          {PRIORITY_VALUES.map((v) => (
            <option key={v} value={v}>
              {v === 0 ? '— priority' : PRIORITY_LABEL[v]}
            </option>
          ))}
        </select>
      )}
      {isOpen && isManual && (
        <button className="rowIcon" title="Edit" onClick={() => onEdit(item)}>
          Edit
        </button>
      )}
      {isOpen && watchId && (
        <button className="thumbsDown" title="Bad match — refine this watch" onClick={() => onRefineWatch(item)}>
          👎
        </button>
      )}
      <button className="rowIcon" title="History — this item’s timeline" onClick={() => onHistory(item)}>
        <Clock size={13} aria-hidden="true" />
      </button>
      {isOpen ? (
        <>
          <button className="dispatch" title="Snooze until tomorrow 9am (z)" onClick={() => onSnooze(item)}>
            Snooze
          </button>
          <button className="dispatch" title="Archive (x)" onClick={() => (isManual ? onDelete(item) : onArchive(item))}>
            Archive
          </button>
          <button className="dispatch done" title="Mark done (e)" onClick={() => onDone(item)}>
            Done
          </button>
          <button className="dispatch" title="Start a Claude Code session on this item" onClick={() => onDispatch(item)}>
            Dispatch
          </button>
        </>
      ) : (
        <>
          <button className="dispatch done" title="Move back to the open inbox" onClick={() => onReopen(item)}>
            Reopen
          </button>
          {tab !== 'archived' && (
            <button className="dispatch" title="Archive" onClick={() => onArchive(item)}>
              Archive
            </button>
          )}
        </>
      )}
    </div>
  )
}
