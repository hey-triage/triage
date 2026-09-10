/**
 * The 280px context panel beside the rail. Two contents, chosen by where you
 * are: the ranked Queue (inbox and item pages) or the Sessions list (home and
 * session pages). Both open with the search field, which is the ⌘K palette.
 */
import {
  ExternalLink,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ScoredItem, SessionSummary } from '../../../shared/protocol.js'
import { GROUP_ORDER, GROUP_SHORT, itemTone, kindIcon } from '../itemUi.js'
import { MOD_LABEL } from '../keys.js'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/Menu.js'

export function PanelSearch({ onSearch, placeholder }: { onSearch: () => void; placeholder: string }) {
  return (
    <div className="panelSearch">
      <button type="button" className="searchBtn" onClick={onSearch} title={`Search (${MOD_LABEL}K)`}>
        <Search size={13} aria-hidden="true" />
        <span className="t">{placeholder}</span>
        <span className="kbd">{MOD_LABEL}K</span>
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Queue — the open inbox, grouped and ranked
// ---------------------------------------------------------------------------

type QueueProps = {
  items: readonly ScoredItem[]
  loaded: boolean
  selectedId: string | null
  onOpenItem: (id: string) => void
  onAdd: () => void
  onRefresh: () => void
  onSearch: () => void
}

export function QueuePanel({ items, loaded, selectedId, onOpenItem, onAdd, onRefresh, onSearch }: QueueProps) {
  return (
    <aside className="panel" aria-label="Queue">
      <PanelSearch onSearch={onSearch} placeholder="Search items, sessions…" />
      <div className="panelBody">
        <div className="panelHead">
          <span>Queue</span>
          <span className="n">{items.length}</span>
          <span className="acts">
            <button type="button" className="iconBtn sm" title="Add a work item (n)" onClick={onAdd}>
              <Plus size={13} aria-hidden="true" />
            </button>
            <button type="button" className="iconBtn sm" title="Refresh (r)" onClick={onRefresh}>
              <RefreshCw size={12} aria-hidden="true" />
            </button>
          </span>
        </div>
        {loaded && items.length === 0 && <div className="panelEmpty">Inbox zero — nothing is waiting on you.</div>}
        {GROUP_ORDER.map((g) => {
          const rows = items.filter((i) => i.group === g)
          if (rows.length === 0) return null
          return (
            <div key={g}>
              <div className="panelGroup">
                {GROUP_SHORT[g]}
                <span className="n">{rows.length}</span>
              </div>
              {rows.map((item) => {
                const Icon = kindIcon(item)
                const tone = itemTone(item)
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`prow${item.id === selectedId ? ' sel' : ''}`}
                    title={item.title}
                    onClick={() => onOpenItem(item.id)}
                  >
                    <Icon size={13} aria-hidden="true" />
                    <span className="t">{item.title}</span>
                    {tone && <span className={`dot sm ${tone}`} aria-hidden="true" />}
                    <span className="m">{Math.round(item.score)}</span>
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>
      <div className="panelFoot">
        <span className="kbd">j</span>
        <span className="kbd">k</span> move <span className="kbd">Enter</span> open <span className="kbd">e</span> done{' '}
        <span className="kbd">z</span> snooze
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// Sessions — every session in the workspace, pinned first
// ---------------------------------------------------------------------------

type SessionsProps = {
  sessions: readonly SessionSummary[]
  currentId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onRename: (id: string, title: string) => void
  onSetPinned: (id: string, pinned: boolean) => void
  onDelete: (id: string) => void
  onSearch: () => void
}

export function SessionsPanel({
  sessions,
  currentId,
  onSelect,
  onNew,
  onRename,
  onSetPinned,
  onDelete,
  onSearch,
}: SessionsProps) {
  // At most one row is being renamed at a time — the panel is a list, not a form.
  const [renaming, setRenaming] = useState<string | null>(null)
  // Deleting is irreversible, so it is confirmed in a modal rather than on the row.
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)

  const pinned = sessions.filter((s) => s.pinned)
  const rest = sessions.filter((s) => !s.pinned)
  const running = sessions.filter((s) => s.status === 'running' || s.status === 'starting').length

  const row = (s: SessionSummary) => (
    <SessionRow
      key={s.id}
      session={s}
      active={s.id === currentId}
      renaming={renaming === s.id}
      onSelect={() => onSelect(s.id)}
      onStartRename={() => setRenaming(s.id)}
      onEndRename={(title) => {
        setRenaming(null)
        if (title !== undefined && title !== s.title) onRename(s.id, title)
      }}
      onSetPinned={(p) => onSetPinned(s.id, p)}
      onDelete={() => setDeleting(s)}
    />
  )

  return (
    <aside className="panel" aria-label="Sessions">
      <PanelSearch onSearch={onSearch} placeholder="Search sessions, items…" />
      <div className="panelBody">
        <div className="panelHead">
          <span>Sessions</span>
          <span className="n">{sessions.length}</span>
          {running > 0 && <span className="n" title="running now">· {running} live</span>}
          <span className="acts">
            <button type="button" className="iconBtn sm" title="New session (n)" onClick={onNew}>
              <Plus size={13} aria-hidden="true" />
            </button>
          </span>
        </div>
        {sessions.length === 0 && (
          <div className="panelEmpty">No sessions yet. Dispatch a work item, or start one from the composer.</div>
        )}
        {pinned.length > 0 && (
          <>
            <div className="panelGroup">
              Pinned <span className="n">{pinned.length}</span>
            </div>
            {pinned.map(row)}
            {rest.length > 0 && (
              <div className="panelGroup">
                Recent <span className="n">{rest.length}</span>
              </div>
            )}
          </>
        )}
        {rest.map(row)}
      </div>
      <div className="panelFoot">
        <span className="kbd">n</span> new session <span className="kbd">g s</span> here
      </div>

      <DeleteSessionDialog
        session={deleting}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) onDelete(deleting.id)
          setDeleting(null)
        }}
      />
    </aside>
  )
}

const STATUS_DOT: Record<SessionSummary['status'], string> = {
  starting: 'live',
  running: 'live',
  idle: 'green',
  error: 'red',
}

type RowProps = {
  session: SessionSummary
  active: boolean
  renaming: boolean
  onSelect: () => void
  onStartRename: () => void
  /** `undefined` = cancelled; a string = the committed title. */
  onEndRename: (title?: string) => void
  onSetPinned: (pinned: boolean) => void
  onDelete: () => void
}

function SessionRow({ session: s, active, renaming, onSelect, onStartRename, onEndRename, onSetPinned, onDelete }: RowProps) {
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renaming) input.current?.select()
  }, [renaming])

  if (renaming) {
    return (
      <div className={`prow${active ? ' sel' : ''}`}>
        <span className={`dot sm ${STATUS_DOT[s.status]}`} aria-hidden="true" />
        <input
          ref={input}
          className="renameInput"
          defaultValue={s.title}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onEndRename(e.currentTarget.value.trim() || undefined)
            else if (e.key === 'Escape') {
              e.stopPropagation()
              onEndRename()
            }
          }}
          onBlur={(e) => onEndRename(e.currentTarget.value.trim() || undefined)}
        />
      </div>
    )
  }

  return (
    <div
      className={`prow${active ? ' sel' : ''}`}
      role="button"
      tabIndex={0}
      title={s.title}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
    >
      <span className={`dot sm ${STATUS_DOT[s.status]}`} aria-hidden="true" />
      <span className="t">{s.title}</span>
      {s.pinned && <Pin className="pinMark" size={11} aria-label="Pinned" />}
      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            className="iconBtn rowMenu"
            aria-label={`Session options for ${s.title}`}
            title="Session options"
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal size={14} aria-hidden="true" />
          </button>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem asChild>
            <a href={`#${s.id}`} target="_blank" rel="noreferrer">
              <ExternalLink size={14} aria-hidden="true" />
              Open in new tab
            </a>
          </MenuItem>
          <MenuItem onSelect={() => onSetPinned(!s.pinned)}>
            {s.pinned ? <PinOff size={14} aria-hidden="true" /> : <Pin size={14} aria-hidden="true" />}
            {s.pinned ? 'Unpin' : 'Pin to top'}
          </MenuItem>
          <MenuItem onSelect={onStartRename}>
            <Pencil size={14} aria-hidden="true" />
            Rename
          </MenuItem>
          <MenuSeparator />
          <MenuItem className="danger" onSelect={onDelete}>
            <Trash2 size={14} aria-hidden="true" />
            Delete
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  )
}

/**
 * The confirmation for a delete. A native <dialog>, like the other modals, so
 * Escape and the backdrop close it and `anyDialogOpen` sees it.
 */
function DeleteSessionDialog({
  session,
  onCancel,
  onConfirm,
}: {
  session: SessionSummary | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (session && !el.open) el.showModal()
    if (!session && el.open) el.close()
  }, [session])

  return (
    <dialog ref={dialog} id="deleteSession" onClose={onCancel} onClick={(e) => e.target === dialog.current && onCancel()}>
      <h3>Delete session?</h3>
      <p>
        <strong>{session?.title}</strong> and its whole transcript will be deleted. This cannot be undone.
      </p>
      <div className="row">
        <button type="button" className="cancel" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="danger" onClick={onConfirm}>
          Delete session
        </button>
      </div>
    </dialog>
  )
}
