import { ChevronRight, Folder, Home, Inbox, MessagesSquare, Plus, Terminal, X, type LucideProps } from 'lucide-react'
import { useEffect, useState, type ComponentType, type MouseEvent } from 'react'
import type { Project, ProjectsResponse } from '../../../shared/protocol.js'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger } from '../ui/Menu.js'

const homely = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, '~')

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
  /** Open a shell — in `cwd`, or the daemon's default (home) when undefined. */
  onNewTerminal: (cwd?: string) => void
  /** The folder a new terminal opens in by default: the active tab's. */
  terminalCwd?: string
}

/** The tab band: Inbox pinned, one closable tab per open session or terminal, + for a new session. */
export function TabBand({ activeKey, tabs, pageTab, onInbox, onSelect, onClose, onNew, onNewTerminal, terminalCwd }: Props) {
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

      <NewTabMenu onNew={onNew} onNewTerminal={onNewTerminal} terminalCwd={terminalCwd} />
    </div>
  )
}

/** The "+": a new session, or a new terminal — here, or in a project folder. */
function NewTabMenu({ onNew, onNewTerminal, terminalCwd }: Pick<Props, 'onNew' | 'onNewTerminal' | 'terminalCwd'>) {
  const [open, setOpen] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])

  useEffect(() => {
    if (!open) return
    void fetch('/api/projects')
      .then((r) => r.json() as Promise<ProjectsResponse>)
      .then((b) => {
        if (b.ok) setProjects(b.projects)
      })
      .catch(() => {})
  }, [open])

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger asChild>
        <button type="button" className="add" title="New tab — session or terminal">
          <Plus size={14} aria-hidden="true" />
        </button>
      </MenuTrigger>
      <MenuContent align="start" className="wide">
        <MenuItem onSelect={onNew}>
          <MessagesSquare size={14} aria-hidden="true" />
          <span className="text">
            <span className="name">New session</span>
            <span className="desc">Pick the project in the composer</span>
          </span>
          <span className="val">n</span>
        </MenuItem>
        <MenuItem onSelect={() => onNewTerminal(terminalCwd)}>
          <Terminal size={14} aria-hidden="true" />
          <span className="text">
            <span className="name">New terminal</span>
            <span className="desc">{terminalCwd ? homely(terminalCwd) : 'Home folder'}</span>
          </span>
        </MenuItem>
        <MenuSeparator />
        <MenuSub>
          <MenuSubTrigger className="nav">
            <Folder size={14} aria-hidden="true" />
            <span className="name">Terminal in…</span>
            <ChevronRight size={14} aria-hidden="true" />
          </MenuSubTrigger>
          <MenuSubContent className="wide">
            {projects.map((p) => (
              <MenuItem key={p.id} onSelect={() => onNewTerminal(p.path)}>
                <Folder size={14} aria-hidden="true" />
                <span className="text">
                  <span className="name">{p.name}</span>
                  <span className="desc">{homely(p.path)}</span>
                </span>
              </MenuItem>
            ))}
            {projects.length > 0 && <MenuSeparator />}
            <MenuItem onSelect={() => onNewTerminal(undefined)}>
              <Home size={14} aria-hidden="true" />
              Home folder
            </MenuItem>
          </MenuSubContent>
        </MenuSub>
      </MenuContent>
    </Menu>
  )
}
