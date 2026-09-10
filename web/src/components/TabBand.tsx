import { Inbox, MessagesSquare, Plus, X, type LucideProps } from 'lucide-react'
import type { ComponentType, MouseEvent } from 'react'

export type SessionTab = {
  id: string
  title: string
  color: string
  running: boolean
}

export type PageTab = { key: string; label: string; icon: ComponentType<LucideProps> }

type Props = {
  /** 'inbox', a session id, or a page tab key */
  activeKey: string
  sessionTabs: readonly SessionTab[]
  /** A transient tab for a rail page (Watches, Projects, …) — never persisted. */
  pageTab?: PageTab | null
  onInbox: () => void
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
}

/** The tab band: Inbox pinned, one closable tab per open session, + for a new one. */
export function TabBand({ activeKey, sessionTabs, pageTab, onInbox, onSelect, onClose, onNew }: Props) {
  return (
    <div className="tabband" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={activeKey === 'inbox'}
        className={`tab${activeKey === 'inbox' ? ' active' : ''}`}
        onClick={onInbox}
      >
        <Inbox size={13} aria-hidden="true" />
        <span className="t">Inbox</span>
      </button>

      {sessionTabs.map((t) => {
        const active = activeKey === t.id
        const close = (e: MouseEvent) => {
          e.stopPropagation()
          onClose(t.id)
        }
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={`tab${active ? ' active' : ''}`}
            title={t.title}
            onClick={() => onSelect(t.id)}
            onAuxClick={(e) => e.button === 1 && close(e)}
          >
            <MessagesSquare size={13} aria-hidden="true" />
            <span className="t">
              <span className={`pdot${t.running ? ' live' : ''}`} style={{ background: t.color }} aria-hidden="true" />
              {t.title}
            </span>
            <span
              className="cl"
              role="button"
              aria-label={`Close ${t.title}`}
              tabIndex={-1}
              onClick={close}
            >
              <X size={11} aria-hidden="true" />
            </span>
          </button>
        )
      })}

      {pageTab && (
        <button type="button" role="tab" aria-selected className="tab active">
          <pageTab.icon size={13} aria-hidden="true" />
          <span className="t">{pageTab.label}</span>
        </button>
      )}

      <button type="button" className="add" title="New session (n)" onClick={onNew}>
        <Plus size={14} aria-hidden="true" />
      </button>
    </div>
  )
}
