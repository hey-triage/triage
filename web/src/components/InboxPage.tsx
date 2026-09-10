import {
  AlarmClock,
  Archive,
  Check,
  ExternalLink,
  Flag,
  Folder,
  Pencil,
  RefreshCw,
  ThumbsDown,
  Trash2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Group,
  ItemListResponse,
  ItemStatus,
  ManualItemResponse,
  Project,
  ProjectsResponse,
  ReposResponse,
  ScoredItem,
  WatchesResponse,
} from '../../../shared/protocol.js'
import { inboxStore, useInbox } from '../inboxStore.js'
import {
  GROUP_ORDER,
  GROUP_TITLE,
  KIND_LABEL,
  PRIORITY_LABEL,
  PRIORITY_VALUES,
  itemTone,
  kindIcon,
  ago,
  weekday,
} from '../itemUi.js'
import { anyDialogOpen, isTypingTarget } from '../keys.js'

/** The status tabs (.docs/watches-v2.md): items are durable and never deleted,
 *  so done/snoozed/archived are viewable, not just write-only. */
const TABS = [
  { id: 'open', label: 'Open' },
  { id: 'snoozed', label: 'Snoozed' },
  { id: 'done', label: 'Done' },
  { id: 'archived', label: 'Archived' },
] as const
type Tab = (typeof TABS)[number]['id']

type OtherState =
  | { phase: 'loading' }
  | { phase: 'ready'; items: ScoredItem[] }
  | { phase: 'error'; message: string }

type Props = {
  onDispatch: (item: ScoredItem) => void
  onRefineWatch: (item: ScoredItem) => void
  onOpenItem: (id: string) => void
  /** Bumped by the shell (Queue panel "+") to open the new-item composer. */
  composeSignal?: number
}

export function InboxPage({ onDispatch, onRefineWatch, onOpenItem, composeSignal = 0 }: Props) {
  const [tab, setTab] = useState<Tab>('open')
  // The open tab reads the shared snapshot (the Queue panel shows the same
  // list); the other tabs are loaded here on demand.
  const snap = useInbox()
  const [other, setOther] = useState<OtherState>({ phase: 'loading' })
  const [reposOpen, setReposOpen] = useState(false)
  const [repoCount, setRepoCount] = useState<number | null>(null)
  const [watchTitles, setWatchTitles] = useState<Map<string, string>>(new Map())
  const [projects, setProjects] = useState<Project[]>([])
  const [composer, setComposer] = useState<{ open: boolean; editing: ScoredItem | null }>({
    open: false,
    editing: null,
  })
  const [scanning, setScanning] = useState(false)
  const [sel, setSel] = useState(0)

  const isOpen = tab === 'open'

  const loadOther = useCallback(async (which: Exclude<Tab, 'open'>) => {
    setOther({ phase: 'loading' })
    try {
      const res = await fetch(`/api/items?status=${which}`)
      const body = (await res.json()) as ItemListResponse
      setOther(body.ok ? { phase: 'ready', items: body.items } : { phase: 'error', message: body.error })
    } catch (err) {
      setOther({ phase: 'error', message: String(err) })
    }
  }, [])

  const reload = useCallback(
    (refresh: boolean) => {
      if (tab === 'open') void inboxStore.refresh(refresh)
      else void loadOther(tab)
    },
    [tab, loadOther],
  )

  const scanNow = useCallback(async () => {
    setScanning(true)
    try {
      await fetch('/api/scan', { method: 'POST' }).catch(() => {})
      // give the forced GitHub reconcile a moment, then reload
      setTimeout(() => void inboxStore.refresh(true), 1200)
    } finally {
      setTimeout(() => setScanning(false), 1200)
    }
  }, [])

  const projectName = useCallback(
    (id?: string) => (id ? projects.find((p) => p.id === id)?.name : undefined),
    [projects],
  )

  const removeLocally = useCallback(
    (id: string) => {
      if (isOpen) inboxStore.patch((items) => items.filter((i) => i.id !== id))
      else setOther((prev) => (prev.phase === 'ready' ? { ...prev, items: prev.items.filter((i) => i.id !== id) } : prev))
    },
    [isOpen],
  )

  // A status change is a recorded transition on a durable item — the row leaves
  // the current tab optimistically; the item is never deleted (.docs/watches-v2.md).
  const setItemState = useCallback(
    async (item: ScoredItem, status: ItemStatus, snoozeUntil?: number) => {
      removeLocally(item.id)
      await fetch('/api/items/state', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: item.id, status, snoozeUntil }),
      }).catch(() => {})
    },
    [removeLocally],
  )

  // A priority override applies to any item and survives re-sync. Reflect the
  // chip immediately; re-ranking lands on the next refresh.
  const setPriority = useCallback((item: ScoredItem, priority: number) => {
    inboxStore.patch((items) => items.map((i) => (i.id === item.id ? { ...i, priority: priority || undefined } : i)))
    void fetch('/api/items/priority', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: item.id, priority: priority || null }),
    }).catch(() => {})
  }, [])

  // "Delete" a manual item archives it (never a hard delete); it moves to Archived.
  const deleteManual = useCallback(
    (item: ScoredItem) => {
      removeLocally(item.id)
      void fetch(`/api/items/manual?id=${encodeURIComponent(item.id)}`, { method: 'DELETE' }).catch(() => {})
    },
    [removeLocally],
  )

  const snooze1d = useCallback(
    (item: ScoredItem) => {
      const t = new Date()
      t.setDate(t.getDate() + 1)
      t.setHours(9, 0, 0, 0)
      void setItemState(item, 'snoozed', t.getTime())
    },
    [setItemState],
  )

  const selectTab = useCallback(
    (next: Tab) => {
      setTab(next)
      setSel(0)
      if (next !== 'open') void loadOther(next)
    },
    [loadOther],
  )

  // Items in on-screen order. The Open tab renders in GROUP_ORDER; the other
  // tabs are a flat, source-time-ordered list.
  const ordered = useMemo<readonly ScoredItem[]>(
    () =>
      isOpen
        ? GROUP_ORDER.flatMap((g) => snap.items.filter((i) => i.group === g))
        : other.phase === 'ready'
          ? other.items
          : [],
    [isOpen, snap.items, other],
  )

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(e) || anyDialogOpen() || e.metaKey || e.ctrlKey || e.altKey) return
      const cur = ordered[sel]
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        setSel((v) => Math.min(v + 1, Math.max(0, ordered.length - 1)))
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSel((v) => Math.max(v - 1, 0))
      } else if (e.key === 'Enter' && cur) {
        e.preventDefault()
        onOpenItem(cur.id)
      } else if (e.key === 'o' && cur?.url) {
        e.preventDefault()
        window.open(cur.url, '_blank', 'noopener')
      } else if (e.key === 'd' && cur) {
        e.preventDefault()
        onDispatch(cur)
      } else if (e.key === 'e' && cur) {
        e.preventDefault()
        void setItemState(cur, isOpen ? 'done' : 'open')
      } else if (e.key === 'x' && cur) {
        e.preventDefault()
        void setItemState(cur, 'archived')
      } else if (e.key === 'z' && cur && isOpen) {
        e.preventDefault()
        snooze1d(cur)
      } else if (e.key === 'r') {
        e.preventDefault()
        reload(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [ordered, sel, isOpen, onDispatch, onOpenItem, reload, setItemState, snooze1d])

  const loadProjects = useCallback(() => {
    void fetch('/api/projects')
      .then((r) => r.json() as Promise<ProjectsResponse>)
      .then((b) => {
        if (b.ok) setProjects(b.projects)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!snap.loaded) void inboxStore.refresh(false)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadProjects])

  // The shell's "+" (Queue panel) opens the composer from anywhere in the inbox.
  const lastSignal = useRef(composeSignal)
  useEffect(() => {
    if (composeSignal !== lastSignal.current) {
      lastSignal.current = composeSignal
      setComposer({ open: true, editing: null })
    }
  }, [composeSignal])

  const loading = isOpen ? !snap.loaded && snap.loading : other.phase === 'loading'
  const error = isOpen ? (!snap.loaded ? snap.error : undefined) : other.phase === 'error' ? other.message : undefined
  const items = ordered
  const blocking = isOpen ? snap.items.filter((i) => i.group === 'blocking').length : 0
  const tabLabel = TABS.find((t) => t.id === tab)?.label ?? ''
  const emptyText = isOpen
    ? snap.notices.length > 0
      ? 'No open items to show — but a source is degraded, so this may be incomplete.'
      : 'Inbox zero — nothing is waiting on you.'
    : `Nothing in ${tabLabel.toLowerCase()}.`

  const rowProps: RowActions = {
    tab,
    watchTitles,
    projectName,
    onSelect: (id) => setSel(ordered.findIndex((i) => i.id === id)),
    onOpen: onOpenItem,
    onDispatch,
    onDone: (i) => void setItemState(i, 'done'),
    onSnooze: snooze1d,
    onArchive: (i) => void setItemState(i, 'archived'),
    onReopen: (i) => void setItemState(i, 'open'),
    onRefineWatch,
    onSetPriority: setPriority,
    onEdit: (i) => setComposer({ open: true, editing: i }),
    onDelete: deleteManual,
  }

  return (
    <div className="page wide" id="inboxPage">
      <div className="glow blue" aria-hidden="true" />
      <div className="inner">
        <div className="pageHead">
          <h1 className="display">
            {isOpen ? weekday() : tabLabel}.{' '}
            <span className="muted">
              {loading && items.length === 0
                ? 'syncing…'
                : `${items.length} item${items.length === 1 ? '' : 's'}${blocking ? `, ${blocking} blocking` : ''}.`}
            </span>
          </h1>
          <span className="pageMeta" title={snap.syncedAt ? new Date(snap.syncedAt).toLocaleString() : undefined}>
            <RefreshCw size={12} aria-hidden="true" />
            {snap.syncedAt ? `synced ${ago(snap.syncedAt)}` : 'not synced yet'}
            {repoCount != null && ` · ${repoCount === 0 ? 'no repos' : `${repoCount} repo${repoCount === 1 ? '' : 's'}`}`}
            {watchTitles.size > 0 && ` · ${watchTitles.size} watch${watchTitles.size === 1 ? '' : 'es'}`}
          </span>
        </div>

        <div className="toolRow">
          <div className="seg" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={`segBtn${tab === t.id ? ' active' : ''}`}
                onClick={() => selectTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="right">
            <button type="button" className="btn sm ghost" onClick={() => setComposer({ open: true, editing: null })}>
              + Add item
            </button>
            <button type="button" className="btn sm ghost mono" onClick={() => setReposOpen(true)}>
              {repoCount == null ? 'Repos' : repoCount === 0 ? 'Repos: none' : `Repos: ${repoCount}`}
            </button>
            <button type="button" className="btn sm ghost" disabled={scanning} onClick={() => void scanNow()}>
              {scanning ? 'Scanning…' : 'Scan now'}
            </button>
            <button type="button" className="btn sm ghost" disabled={loading} onClick={() => reload(true)}>
              {loading ? 'Syncing…' : 'Refresh'}
            </button>
          </div>
        </div>

        {loading && items.length === 0 && (
          <div className="probing">
            <span className="pip" /> {isOpen ? 'Syncing sources…' : 'Loading…'}
          </div>
        )}

        {error && <div className="msg error">Sync failed: {error}</div>}

        {!loading && !error && (
          <>
            {isOpen &&
              snap.notices.map((n) => (
                <div key={n} className="notice">
                  {n}
                </div>
              ))}
            {items.length === 0 ? (
              <div className="inboxEmpty">
                {emptyText}
                {isOpen && (
                  <button type="button" className="btn" onClick={() => setComposer({ open: true, editing: null })}>
                    Add a work item
                  </button>
                )}
              </div>
            ) : isOpen ? (
              <div className="homeList">
                {GROUP_ORDER.map((g) => (
                  <ItemGroup
                    key={g}
                    group={g}
                    items={snap.items.filter((i) => i.group === g)}
                    selectedId={ordered[sel]?.id ?? null}
                    {...rowProps}
                  />
                ))}
              </div>
            ) : (
              <div className="homeList">
                {items.map((item) => (
                  <WorkCard key={item.id} item={item} selected={item.id === (ordered[sel]?.id ?? null)} {...rowProps} />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <RepoPicker
        open={reposOpen}
        onClose={() => setReposOpen(false)}
        onSaved={(count) => {
          setRepoCount(count)
          setReposOpen(false)
          void inboxStore.refresh(true) // scope changed — resync now
        }}
      />

      <ItemComposer
        open={composer.open}
        editing={composer.editing}
        projects={projects}
        onClose={() => setComposer({ open: false, editing: null })}
        onSaved={() => {
          setComposer({ open: false, editing: null })
          reload(false) // include the new/edited item
        }}
        onSavedMore={() => reload(false)} // "Add more" — refresh, stay open
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

type RowActions = {
  tab: Tab
  watchTitles: Map<string, string>
  projectName: (id?: string) => string | undefined
  onSelect: (id: string) => void
  onOpen: (id: string) => void
  onDispatch: (item: ScoredItem) => void
  onDone: (item: ScoredItem) => void
  onSnooze: (item: ScoredItem) => void
  onArchive: (item: ScoredItem) => void
  onReopen: (item: ScoredItem) => void
  onRefineWatch: (item: ScoredItem) => void
  onSetPriority: (item: ScoredItem, priority: number) => void
  onEdit: (item: ScoredItem) => void
  onDelete: (item: ScoredItem) => void
}

function ItemGroup({
  group,
  items,
  selectedId,
  ...actions
}: { group: Group; items: ScoredItem[]; selectedId: string | null } & RowActions) {
  if (items.length === 0) return null
  return (
    <>
      <div className="secLabel">{GROUP_TITLE[group]}</div>
      {items.map((item) => (
        <WorkCard key={item.id} item={item} selected={item.id === selectedId} {...actions} />
      ))}
    </>
  )
}

function WorkCard({
  item,
  selected,
  tab,
  watchTitles,
  projectName,
  onSelect,
  onOpen,
  onDispatch,
  onDone,
  onSnooze,
  onArchive,
  onReopen,
  onRefineWatch,
  onSetPriority,
  onEdit,
  onDelete,
}: { item: ScoredItem; selected: boolean } & RowActions) {
  const isManual = item.source === 'manual'
  const isOpen = tab === 'open'
  const proj = projectName(item.projectId)
  const pri = item.priority ?? 0
  // watchId now rides in the provenance list; fall back to the item field.
  const watchId = item.watchId ?? item.foundBy?.[item.foundBy.length - 1]?.watchId
  const Icon = kindIcon(item)
  const tone = itemTone(item)
  const quiet = item.group === 'cycle' || item.group === 'fyi'

  return (
    <div
      className={`card wcard${selected ? ' sel' : ''}${quiet ? ' quiet' : ''}`}
      ref={selected ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
      onMouseMove={() => !selected && onSelect(item.id)}
    >
      <div className="main">
        <div className="cmeta">
          <Icon size={13} aria-hidden="true" />
          <span className="repo">{item.repo}</span>
          <span className="sep">·</span>
          <span>{KIND_LABEL[item.kind] ?? item.kind}</span>
          {item.peopleWaiting > 0 && (
            <>
              <span className="sep">·</span>
              <span>{item.peopleWaiting} waiting</span>
            </>
          )}
          {item.ciFailing && (
            <>
              <span className="sep">·</span>
              <span style={{ color: 'var(--red)' }}>CI red</span>
            </>
          )}
          <span className="score">↑ {Math.round(item.score)}</span>
        </div>
        <button type="button" className="title" title={item.title} onClick={() => onOpen(item.id)}>
          {item.returned && (
            <span className="returned" title="Was done — the source updated since">
              ↩ returned
            </span>
          )}
          {item.title}
        </button>
        <div className="status">
          <span className={`dot ${tone ?? (item.group === 'blocking' ? 'green' : 'stone')}`} aria-hidden="true" />
          <span>{item.reason}</span>
          {item.why && <span className="why">“{item.why}”</span>}
          {proj && (
            <span className="pill" title="Project">
              <Folder size={10} aria-hidden="true" />
              {proj}
            </span>
          )}
          {pri > 0 && (
            <span className={`pill ${pri <= 2 ? 'yellow' : ''}`} title="Priority">
              {PRIORITY_LABEL[pri]}
            </span>
          )}
          {watchId && watchTitles.has(watchId) && (
            <span className="pill blue" title="Matched by this watch">
              {watchTitles.get(watchId)}
            </span>
          )}
          {item.linked?.map((l) => (
            <a key={l.url} className="pill" href={l.url} target="_blank" rel="noreferrer" title="Same work, another source">
              + {l.source} · {l.repo}
            </a>
          ))}
        </div>
      </div>

      <div className="side">
        {isOpen ? (
          <button
            type="button"
            className={`btn${selected ? ' primary' : ''}`}
            title="Start a Claude Code session on this item (d)"
            onClick={() => onDispatch(item)}
          >
            Dispatch
          </button>
        ) : (
          <button type="button" className={`btn${selected ? ' primary' : ''}`} title="Move back to the open inbox (e)" onClick={() => onReopen(item)}>
            Reopen
          </button>
        )}
        <div className="sideRow">
          {item.url && (
            <a className="iconBtn sm" href={item.url} target="_blank" rel="noreferrer" title="Open at the source (o)">
              <ExternalLink size={13} aria-hidden="true" />
            </a>
          )}
          {isOpen && (
            <>
              <button type="button" className="iconBtn sm green" title="Mark done (e)" onClick={() => onDone(item)}>
                <Check size={14} aria-hidden="true" />
              </button>
              <button type="button" className="iconBtn sm" title="Snooze until tomorrow 9am (z)" onClick={() => onSnooze(item)}>
                <AlarmClock size={13} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="iconBtn sm"
                title={isManual ? 'Delete — moves to Archived (x)' : 'Archive (x)'}
                onClick={() => (isManual ? onDelete(item) : onArchive(item))}
              >
                {isManual ? <Trash2 size={13} aria-hidden="true" /> : <Archive size={13} aria-hidden="true" />}
              </button>
              {isManual && (
                <button type="button" className="iconBtn sm" title="Edit" onClick={() => onEdit(item)}>
                  <Pencil size={13} aria-hidden="true" />
                </button>
              )}
              {watchId && (
                <button type="button" className="iconBtn sm red" title="Bad match — refine this watch" onClick={() => onRefineWatch(item)}>
                  <ThumbsDown size={13} aria-hidden="true" />
                </button>
              )}
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
            </>
          )}
          {!isOpen && tab !== 'archived' && (
            <button type="button" className="iconBtn sm" title="Archive" onClick={() => onArchive(item)}>
              <Archive size={13} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </div>
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
      const path = editing ? `/api/items/manual?id=${encodeURIComponent(editing.id)}` : '/api/items/manual'
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
            <Flag size={12} aria-hidden="true" />
            <select value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
              {PRIORITY_VALUES.map((v) => (
                <option key={v} value={v}>
                  {v === 0 ? 'Priority' : PRIORITY_LABEL[v]}
                </option>
              ))}
            </select>
          </label>
          <label className={`pill${projectId ? ' set' : ''}`} title="Project">
            <Folder size={12} aria-hidden="true" />
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
              <input type="checkbox" checked={addMore} onChange={(e) => setAddMore(e.target.checked)} />
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
// Repo picker: which repos the GitHub source is scoped to, per workspace.
// Empty = no GitHub items (scope is opt-in per workspace — see workspaces.md).
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
        The GitHub source only pulls from checked repos, and this scope is per workspace. Nothing
        checked = no GitHub items here.
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
            {selected.size === 0 ? 'no repos — no GitHub items' : `${selected.size} selected`}
            {selected.size > 0 && (
              <button type="button" className="clearSel" onClick={() => setSelected(new Set())}>
                clear
              </button>
            )}
          </div>
        </>
      )}
      <div className="row">
        <button type="button" className="cancel" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="go" disabled={state.phase !== 'ready' || saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </dialog>
  )
}
