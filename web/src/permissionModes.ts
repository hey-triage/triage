/**
 * The permission modes a session can run in, as the UI describes them.
 *
 * The wire values are mostly the SDK's own ('gated' is triage's, enforced
 * server-side); only the copy lives here. Order is the cycle order — least to
 * most permissive — so Shift+Tab walks it the way Claude Code's own does.
 */
import type { PermissionMode } from '../../shared/protocol.js'

export type PermissionModeInfo = {
  id: PermissionMode
  /** Menu row and chip label. */
  name: string
  /** One line under the name. */
  description: string
  /** Drives the chip's colour: how much this mode gives away. */
  risk: 'none' | 'some' | 'high'
}

export const PERMISSION_MODES: PermissionModeInfo[] = [
  {
    id: 'default',
    name: 'Ask every time',
    description: 'Nothing runs until you say so.',
    risk: 'none',
  },
  {
    id: 'gated',
    name: 'Reads run, writes ask',
    description: 'Lookups and file reads go through on their own; anything that writes, runs, or posts still asks.',
    risk: 'some',
  },
  {
    id: 'acceptEdits',
    name: 'Auto-accept edits',
    description: 'File edits go through. Commands and everything else still ask.',
    risk: 'some',
  },
  {
    id: 'auto',
    name: 'Auto',
    description: 'Claude waves through the routine calls and still asks about the risky ones.',
    risk: 'some',
  },
  {
    id: 'bypassPermissions',
    name: 'Bypass all',
    description: 'Never asks — any command, any file. Use only where the blast radius is yours.',
    risk: 'high',
  },
]

export const DEFAULT_MODE: PermissionMode = 'default'

export function findMode(id: PermissionMode | undefined): PermissionModeInfo {
  return PERMISSION_MODES.find((m) => m.id === id) ?? PERMISSION_MODES[0]
}

/**
 * The next mode in the cycle. Bypass is deliberately not reachable this way —
 * a keystroke should not be able to land you on "never ask again"; that one
 * costs a deliberate trip through the menu.
 */
export function nextMode(id: PermissionMode | undefined): PermissionMode {
  const cycle = PERMISSION_MODES.filter((m) => m.risk !== 'high')
  const i = cycle.findIndex((m) => m.id === (id ?? DEFAULT_MODE))
  return cycle[(i + 1) % cycle.length].id
}

/** A stored mode string is only usable if it is still a mode we know. */
export const isPermissionMode = (v: unknown): v is PermissionMode =>
  typeof v === 'string' && PERMISSION_MODES.some((m) => m.id === v)
