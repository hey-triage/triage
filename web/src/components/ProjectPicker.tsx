import { Check, ChevronDown, Folder, Settings2 } from 'lucide-react'
import type { Project } from '../../../shared/protocol.js'
import { projectColor } from '../tabs.js'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/Menu.js'

type Props = {
  projects: readonly Project[]
  /** the folder a session would start in */
  cwd: string
  onPick: (cwd: string) => void
  disabled?: boolean
}

const homely = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, '~')

/**
 * Which project a draft runs in. A menu, not a native select: each row shows
 * the project's colour, name, repo and folder, so two projects with similar
 * names never get confused, and the current one is checked.
 */
export function ProjectPicker({ projects, cwd, onPick, disabled }: Props) {
  const current = projects.find((p) => p.path === cwd)
  const label = current?.name ?? homely(cwd).split('/').filter(Boolean).pop() ?? cwd

  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className="chip ink pick" title={`Project folder: ${cwd}`} disabled={disabled}>
          <span className="pdot" style={{ background: projectColor(cwd) }} aria-hidden="true" />
          <span className="name">{label}</span>
          <ChevronDown size={11} aria-hidden="true" />
        </button>
      </MenuTrigger>
      <MenuContent align="start" className="projMenu">
        <div className="projMenuHead">Run in</div>
        {projects.map((p) => {
          const on = p.path === cwd
          return (
            <MenuItem key={p.id} className={`projRowItem${on ? ' on' : ''}`} onSelect={() => onPick(p.path)}>
              <span className="pdot" style={{ background: projectColor(p.path) }} aria-hidden="true" />
              <span className="text">
                <span className="name">{p.name}</span>
                <span className="desc">
                  {p.repo && <span className="repo">{p.repo}</span>}
                  {p.repo && <span className="sep">·</span>}
                  <span className="path">{homely(p.path)}</span>
                </span>
              </span>
              {on && <Check className="check" size={13} aria-hidden="true" />}
            </MenuItem>
          )
        })}
        {!current && (
          <MenuItem className="projRowItem on" onSelect={() => onPick(cwd)}>
            <span className="pdot" style={{ background: projectColor(cwd) }} aria-hidden="true" />
            <span className="text">
              <span className="name">{label}</span>
              <span className="desc">
                <span className="path">{homely(cwd)}</span>
                <span className="sep">·</span>
                <span>not a saved project</span>
              </span>
            </span>
            <Check className="check" size={13} aria-hidden="true" />
          </MenuItem>
        )}
        {projects.length === 0 && <div className="projMenuEmpty">No projects yet. Add the folders you work in.</div>}
        <MenuSeparator />
        <MenuItem asChild>
          <a href="#/settings/projects">
            <Settings2 size={14} aria-hidden="true" />
            Manage projects…
          </a>
        </MenuItem>
        <MenuItem asChild>
          <a href="#/settings/projects">
            <Folder size={14} aria-hidden="true" />
            Add a project…
          </a>
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}
