import { Check, ChevronDown, ChevronRight, Sparkles } from 'lucide-react'
import type { EffortLevel, ModelOption } from '../../../shared/protocol.js'
import { EFFORT_LABEL, findModel, useModels } from '../models.js'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger } from '../ui/Menu.js'

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

  const selected = findModel(models, model)
  const efforts = selected?.efforts ?? []

  function pickModel(m: ModelOption) {
    // A model that cannot do the current effort level drops it rather than
    // carrying a setting the next turn would silently ignore.
    const keep = effort && m.efforts.includes(effort) ? effort : undefined
    onChange(m.id, keep)
  }

  function pickEffort(level: EffortLevel | undefined) {
    // `selected.id` rather than `model`: when nothing was ever picked, `model`
    // is the wire id the SDK reported, and passing it back would silently pin
    // the session to that exact model instead of leaving it on the default.
    onChange(selected?.id ?? model, level)
  }

  const label = selected?.name ?? (models.length ? 'Model' : 'Loading models…')
  const featured = models.slice(0, FEATURED)
  const more = models.slice(FEATURED)

  return (
    <div className="modelPicker">
      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            className="chip model"
            disabled={disabled || models.length === 0}
            title="Choose the model this session runs on"
          >
            <Sparkles size={14} aria-hidden="true" />
            <span className="name">{label}</span>
            {effort && <span className="eff">{EFFORT_LABEL[effort]}</span>}
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        </MenuTrigger>

        <MenuContent className="models" side="top" align="start">
          {featured.map((m) => (
            <MenuItem key={m.id} className="wrap" onSelect={() => pickModel(m)}>
              <span className="text">
                <span className="name">{m.name}</span>
                <span className="desc">{m.description}</span>
              </span>
              {m === selected && <Check className="check" size={14} aria-hidden="true" />}
            </MenuItem>
          ))}

          {(efforts.length > 0 || more.length > 0) && <MenuSeparator />}

          {efforts.length > 0 && (
            <MenuSub>
              <MenuSubTrigger className="nav">
                <span className="name">Effort</span>
                <span className="val">{effort ? EFFORT_LABEL[effort] : 'Default'}</span>
                <ChevronRight size={14} aria-hidden="true" />
              </MenuSubTrigger>
              <MenuSubContent>
                <p className="uiMenuBlurb">
                  Higher effort means more thorough responses, but takes longer and uses your limits
                  faster.
                </p>
                <MenuItem onSelect={() => pickEffort(undefined)}>
                  <span className="name">Default</span>
                  {!effort && <Check className="check" size={14} aria-hidden="true" />}
                </MenuItem>
                {efforts.map((level) => (
                  <MenuItem key={level} onSelect={() => pickEffort(level)}>
                    <span className="name">{EFFORT_LABEL[level]}</span>
                    {effort === level && <Check className="check" size={14} aria-hidden="true" />}
                  </MenuItem>
                ))}
              </MenuSubContent>
            </MenuSub>
          )}

          {more.length > 0 && (
            <MenuSub>
              <MenuSubTrigger className="nav">
                <span className="name">More models</span>
                <ChevronRight size={14} aria-hidden="true" />
              </MenuSubTrigger>
              <MenuSubContent className="models">
                {more.map((m) => (
                  <MenuItem key={m.id} className="wrap" onSelect={() => pickModel(m)}>
                    <span className="text">
                      <span className="name">{m.name}</span>
                      <span className="desc">{m.description}</span>
                    </span>
                    {m === selected && <Check className="check" size={14} aria-hidden="true" />}
                  </MenuItem>
                ))}
              </MenuSubContent>
            </MenuSub>
          )}
        </MenuContent>
      </Menu>
    </div>
  )
}
