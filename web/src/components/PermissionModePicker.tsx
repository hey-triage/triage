import { Check, ChevronDown, ShieldCheck } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { PermissionMode } from '../../../shared/protocol.js'
import { findMode, PERMISSION_MODES } from '../permissionModes.js'

type Props = {
  mode?: PermissionMode
  onChange: (mode: PermissionMode) => void
  disabled?: boolean
}

/** How much a session asks before acting. Same chip idiom as the model picker. */
export function PermissionModePicker({ mode, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState<PermissionMode | null>(null)
  const root = useRef<HTMLDivElement>(null)

  const selected = findMode(mode)

  // Dismissal: anywhere outside, or Escape — matching ModelPicker, so the two
  // chips in one statusline behave the same way.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (!root.current?.contains(e.target as Node)) close()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  function close() {
    setOpen(false)
    setConfirming(null)
  }

  function pick(id: PermissionMode) {
    // Turning off every check is the one choice that gets a second question:
    // it is the only mode where a mis-click has no later chance to be caught.
    if (id === 'bypassPermissions' && mode !== id) {
      setConfirming(id)
      return
    }
    onChange(id)
    close()
  }

  return (
    <div className="permPicker" ref={root} data-popover-open={open || undefined}>
      <button
        type="button"
        className={`chip perm risk-${selected.risk}`}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${selected.name} — ${selected.description}`}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <ShieldCheck size={14} aria-hidden="true" />
        <span className="name">{selected.name}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>

      {open && (
        <div className="menu" role="menu">
          {PERMISSION_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="menuitemradio"
              aria-checked={m.id === selected.id}
              className={`row risk-${m.risk}${m.id === selected.id ? ' on' : ''}`}
              onClick={() => pick(m.id)}
            >
              <span className="text">
                <span className="name">{m.name}</span>
                <span className="desc">{m.description}</span>
              </span>
              {m.id === selected.id && <Check size={14} aria-hidden="true" />}
            </button>
          ))}

          {confirming ? (
            <div className="confirm">
              <p>
                Bypass runs every command and edit without asking — including ones that delete work
                or reach the network. Turn it on only where you can afford the worst case.
              </p>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  onChange(confirming)
                  close()
                }}
              >
                Turn off all checks
              </button>
              <button type="button" className="cancel" onClick={() => setConfirming(null)}>
                Cancel
              </button>
            </div>
          ) : (
            <p className="blurb">
              Applies to this session, from the next tool call on. <kbd>Shift+Tab</kbd> cycles.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
