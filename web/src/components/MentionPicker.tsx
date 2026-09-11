import * as Popover from '@radix-ui/react-popover'
import { File, Folder, Inbox, MessagesSquare } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import type { Mention, MentionKind } from '../../../shared/protocol.js'
import type { MentionHit } from '../mentions.js'

type Group = { kind: MentionKind; title: string; hits: MentionHit[] }

type Props = {
  open: boolean
  groups: Group[]
  /** index into the flattened hit list */
  selected: number
  onHover: (index: number) => void
  onPick: (m: MentionHit) => void
  /** the textarea the popover hangs off */
  children: ReactNode
}

/** The glyph for a mention kind — shared by the picker, the tray chips and the transcript. */
export function MentionIcon({ kind, dir, size = 13 }: { kind: MentionKind; dir?: boolean; size?: number }) {
  if (kind === 'item') return <Inbox size={size} aria-hidden="true" />
  if (kind === 'session') return <MessagesSquare size={size} aria-hidden="true" />
  return dir ? <Folder size={size} aria-hidden="true" /> : <File size={size} aria-hidden="true" />
}

export const flatHits = (groups: readonly Group[]): MentionHit[] => groups.flatMap((g) => g.hits)

/**
 * The `@` picker: a popover above the prompt box listing what the token under
 * the caret could mean, grouped by kind. Focus never leaves the textarea — the
 * box's own key handler drives selection, so typing keeps narrowing the list.
 */
export function MentionPicker({ open, groups, selected, onHover, onPick, children }: Props) {
  const list = useRef<HTMLDivElement>(null)
  const empty = flatHits(groups).length === 0

  // Keep the selected row in view as the arrow keys move it.
  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>('.mnOpt.sel')
    el?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  let index = 0
  return (
    <Popover.Root open={open}>
      <Popover.Anchor asChild>{children}</Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          className="mnPop"
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <div className="mnList" ref={list} role="listbox" aria-label="Mention">
            {empty && <div className="mnEmpty">Nothing matches — keep typing, or try item: or session:</div>}
            {groups.map((g) =>
              g.hits.length === 0 ? null : (
                <div className="mnGroup" key={g.kind}>
                  <div className="mnHead">{g.title}</div>
                  {g.hits.map((h) => {
                    const i = index++
                    return (
                      <button
                        type="button"
                        key={`${h.kind}:${h.ref}`}
                        className={'mnOpt' + (i === selected ? ' sel' : '')}
                        role="option"
                        aria-selected={i === selected}
                        // Move, not enter: a pointer resting where the list
                        // appears must not steal the selection from the keys.
                        onMouseMove={() => onHover(i)}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => onPick(h)}
                        title={h.kind === 'file' ? h.ref : h.label}
                      >
                        <MentionIcon kind={h.kind} dir={h.dir} />
                        <span className="n">{h.label}</span>
                        {h.hint && <span className="d">{h.hint}</span>}
                      </button>
                    )
                  })}
                </div>
              ),
            )}
          </div>
          <div className="mnFoot">
            <span>
              <kbd>↑↓</kbd> move · <kbd>↵</kbd> attach · <kbd>esc</kbd> close
            </span>
            <span className="mnHint">@item: · @session: · @path</span>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** A picked mention in the tray or the transcript, with the kind's glyph. */
export function MentionChip({
  m,
  dir,
  title,
  muted,
  onRemove,
}: {
  m: Mention
  dir?: boolean
  title?: string
  /** a mention that resolved to nothing more than its name */
  muted?: boolean
  onRemove?: () => void
}) {
  return (
    <span className={'mchip' + (muted ? ' muted' : '')} title={title ?? (m.kind === 'file' ? m.ref : m.label)}>
      <MentionIcon kind={m.kind} dir={dir ?? m.ref.endsWith('/')} size={11} />
      <span className="n">{m.label}</span>
      {onRemove && (
        <button type="button" className="x" onClick={onRemove} aria-label={`Remove ${m.label}`} title="Remove">
          ×
        </button>
      )}
    </span>
  )
}
