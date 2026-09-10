import { Inbox, MessagesSquare, Plus, Terminal, X, type LucideProps } from 'lucide-react'
import type { ComponentType, MouseEvent } from 'react'

export type OpenTab = {
  /** the tab-band key: a session id, or `term:<id>` for a terminal */
  key: string
  kind: 'session' | 'terminal'
  title: string
  color: string
  /** live: a working session, or a running shell */
  running: boolean
}

export type PageTab = { key: string; label: string; icon: ComponentType<LucideProps> }

type Props = {
  /** 'inbox', a tab key, or a page tab key */
  activeKey: string
  tabs: readonly OpenTab[]
  /** A transient tab for a rail page (Watches, Projects, …) — never persisted. */
  pageTab?: PageTab | null
  onInbox: () => void
  onSelect: (key: string) => void
  onClose: (key: string) => void
  onNew: () => void
}

/** The tab band: Inbox pinned, one closable tab per open session or terminal, + for a new session. */
export function TabBand({ activeKey, tabs, pageTab, onInbox, onSelect, onClose, onNew }: Props) {
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

      {tabs.map((t) => {
        const active = activeKey === t.key
        const close = (e: MouseEvent) => {
          e.stopPropagation()
          onClose(t.key)
        }
        const Icon = t.kind === 'terminal' ? Terminal : MessagesSquare
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active}
            className={`tab${active ? ' active' : ''}`}
            title={t.title}
            onClick={() => onSelect(t.key)}
            onAuxClick={(e) => e.button === 1 && close(e)}
          >
            <Icon size={13} aria-hidden="true" />
            <span className="t">
              <span className={`pdot${t.running ? ' live' : ''}`} style={{ background: t.color }} aria-hidden="true" />
              {t.title}
            </span>
            <span className="cl" role="button" aria-label={`Close ${t.title}`} tabIndex={-1} onClick={close}>
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
