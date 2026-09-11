import { Activity, Check, ChevronsUpDown, CircleHelp, Gauge, Plus, Settings, Settings2 } from 'lucide-react'
import { MOD_LABEL } from '../keys.js'
import type { Workspace } from '../../../shared/protocol.js'
import type { ConnState } from '../store.js'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/Menu.js'

type Props = {
  workspaces: readonly Workspace[]
  workspaceId: string
  conn: ConnState
  onSwitchWorkspace: (id: string) => void
  onNewWorkspace: () => void
  onWorkspaceSettings: () => void
  onOpenSystem: (tab: 'status' | 'activity') => void
  onOpenSettings: () => void
  onHelp: () => void
}

const CONN_TITLE: Record<ConnState, string> = {
  connecting: 'Connecting to the daemon…',
  connected: 'Daemon connected — system status',
  disconnected: 'Daemon disconnected — retrying',
}

/** 44px top bar: serif wordmark, the workspace pill, then system / activity / settings / help. */
export function TopBar({
  workspaces,
  workspaceId,
  conn,
  onSwitchWorkspace,
  onNewWorkspace,
  onWorkspaceSettings,
  onOpenSystem,
  onOpenSettings,
  onHelp,
}: Props) {
  return (
    <header className="topbar">
      <span className="wordmark">triage</span>
      <WorkspaceSwitcher
        workspaces={workspaces}
        workspaceId={workspaceId}
        onSwitch={onSwitchWorkspace}
        onNew={onNewWorkspace}
        onSettings={onWorkspaceSettings}
      />
      <span className="spacer" />
      <button type="button" className="topIcon" title={CONN_TITLE[conn]} onClick={() => onOpenSystem('status')}>
        <Gauge size={15} aria-hidden="true" />
        <span className={`connDot ${conn === 'connected' ? '' : conn === 'connecting' ? 'connecting' : 'down'}`} aria-hidden="true" />
      </button>
      <button type="button" className="topIcon" title="Watch runs and activity" onClick={() => onOpenSystem('activity')}>
        <Activity size={15} aria-hidden="true" />
      </button>
      <button type="button" className="topIcon" title={`Settings (${MOD_LABEL},)`} onClick={onOpenSettings}>
        <Settings size={15} aria-hidden="true" />
      </button>
      <button type="button" className="topIcon" title="Keyboard shortcuts (?)" onClick={onHelp}>
        <CircleHelp size={15} aria-hidden="true" />
      </button>
    </header>
  )
}

/**
 * The workspace switcher (.docs/workspaces.md): which world am I in, and the
 * door to the others. The colour dot is the ambient signal; the menu lists
 * every workspace (active checked), plus New and Settings.
 */
function WorkspaceSwitcher({
  workspaces,
  workspaceId,
  onSwitch,
  onNew,
  onSettings,
}: {
  workspaces: readonly Workspace[]
  workspaceId: string
  onSwitch: (id: string) => void
  onNew: () => void
  onSettings: () => void
}) {
  const active = workspaces.find((w) => w.id === workspaceId)
  if (!active) return null // hello not in yet
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className="wsPill" title={`Workspace: ${active.name}`}>
          <span className="wsDot" style={{ background: active.color }} aria-hidden="true" />
          <span className="wsName">{active.name}</span>
          <ChevronsUpDown size={11} aria-hidden="true" />
        </button>
      </MenuTrigger>
      <MenuContent align="start" className="wsMenu">
        {workspaces.map((w) => (
          <MenuItem key={w.id} onSelect={() => w.id !== workspaceId && onSwitch(w.id)}>
            <span className="wsDot" style={{ background: w.color }} aria-hidden="true" />
            <span className="wsMenuName">
              {w.name}
              {w.isDefault && <em className="wsDefaultTag">default</em>}
            </span>
            {w.id === workspaceId && <Check size={13} aria-hidden="true" />}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem onSelect={onNew}>
          <Plus size={14} aria-hidden="true" />
          New workspace…
        </MenuItem>
        <MenuItem onSelect={onSettings}>
          <Settings2 size={14} aria-hidden="true" />
          Workspace settings…
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}
