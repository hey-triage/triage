import { Check, ChevronDown, ChevronRight, Sparkles } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { EffortLevel, ModelOption } from '../../../shared/protocol.js'
import { EFFORT_LABEL, findModel, useModels } from '../models.js'

type Props = {
  /** The current model — an alias the user picked, or the wire id the SDK reported. */
  model?: string
  effort?: EffortLevel
  /** `undefined` on either side means "whatever Claude Code defaults to". */
  onChange: (model: string | undefined, effort: EffortLevel | undefined) => void
  disabled?: boolean
}

/** How many models sit in the menu itself; the rest go behind "More models". */
const FEATURED = 5

export function ModelPicker({ model, effort, onChange, disabled }: Props) {
  const models = useModels()
  const [open, setOpen] = useState(false)
  const [submenu, setSubmenu] = useState<'effort' | 'more' | null>(null)
  const root = useRef<HTMLDivElement>(null)

  const selected = findModel(models, model)
  const efforts = selected?.efforts ?? []

  // Dismissal: anywhere outside, or Escape. Both close the submenu too, so the
  // menu never reopens mid-flight into a stale branch.
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
    setSubmenu(null)
  }

  function pickModel(m: ModelOption) {
    // A model that cannot do the current effort level drops it rather than
    // carrying a setting the next turn would silently ignore.
    const keep = effort && m.efforts.includes(effort) ? effort : undefined
    onChange(m.id, keep)
    close()
  }

  function pickEffort(level: EffortLevel | undefined) {
    // `selected.id` rather than `model`: when nothing was ever picked, `model`
    // is the wire id the SDK reported, and passing it back would silently pin
    // the session to that exact model instead of leaving it on the default.
    onChange(selected?.id ?? model, level)
    close()
  }

  const label = selected?.name ?? (models.length ? 'Model' : 'Loading models…')
  const featured = models.slice(0, FEATURED)
  const more = models.slice(FEATURED)

  return (
    <div className="modelPicker" ref={root} data-popover-open={open || undefined}>
      <button
        type="button"
        className="chip model"
        disabled={disabled || models.length === 0}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Choose the model this session runs on"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Sparkles size={14} aria-hidden="true" />
        <span className="name">{label}</span>
        {effort && <span className="eff">{EFFORT_LABEL[effort]}</span>}
        <ChevronDown size={12} aria-hidden="true" />
      </button>

      {open && (
        <div className="menu" role="menu">
          {featured.map((m) => (
            <button
              key={m.id}
              type="button"
              role="menuitemradio"
              aria-checked={m === selected}
              className={`row model${m === selected ? ' on' : ''}`}
              onMouseEnter={() => setSubmenu(null)}
              onClick={() => pickModel(m)}
            >
              <span className="text">
                <span className="name">{m.name}</span>
                <span className="desc">{m.description}</span>
              </span>
              {m === selected && <Check size={14} aria-hidden="true" />}
            </button>
          ))}

          {(efforts.length > 0 || more.length > 0) && <div className="sep" />}

          {efforts.length > 0 && (
            <div className="sub">
              <button
                type="button"
                className={`row nav${submenu === 'effort' ? ' open' : ''}`}
                aria-haspopup="menu"
                aria-expanded={submenu === 'effort'}
                onMouseEnter={() => setSubmenu('effort')}
                onClick={() => setSubmenu(submenu === 'effort' ? null : 'effort')}
              >
                <span className="name">Effort</span>
                <span className="val">{effort ? EFFORT_LABEL[effort] : 'Default'}</span>
                <ChevronRight size={14} aria-hidden="true" />
              </button>

              {submenu === 'effort' && (
                <div className="submenu" role="menu">
                  <p className="blurb">
                    Higher effort means more thorough responses, but takes longer and uses your
                    limits faster.
                  </p>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={!effort}
                    className={`row${!effort ? ' on' : ''}`}
                    onClick={() => pickEffort(undefined)}
                  >
                    <span className="name">Default</span>
                    {!effort && <Check size={14} aria-hidden="true" />}
                  </button>
                  {efforts.map((level) => (
                    <button
                      key={level}
                      type="button"
                      role="menuitemradio"
                      aria-checked={effort === level}
                      className={`row${effort === level ? ' on' : ''}`}
                      onClick={() => pickEffort(level)}
                    >
                      <span className="name">{EFFORT_LABEL[level]}</span>
                      {effort === level && <Check size={14} aria-hidden="true" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {more.length > 0 && (
            <div className="sub">
              <button
                type="button"
                className={`row nav${submenu === 'more' ? ' open' : ''}`}
                aria-haspopup="menu"
                aria-expanded={submenu === 'more'}
                onMouseEnter={() => setSubmenu('more')}
                onClick={() => setSubmenu(submenu === 'more' ? null : 'more')}
              >
                <span className="name">More models</span>
                <ChevronRight size={14} aria-hidden="true" />
              </button>

              {submenu === 'more' && (
                <div className="submenu wide" role="menu">
                  {more.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={m === selected}
                      className={`row model${m === selected ? ' on' : ''}`}
                      onClick={() => pickModel(m)}
                    >
                      <span className="text">
                        <span className="name">{m.name}</span>
                        <span className="desc">{m.description}</span>
                      </span>
                      {m === selected && <Check size={14} aria-hidden="true" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
