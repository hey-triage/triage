import { ArrowUp, ImagePlus, Square } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  mentionToken,
  type EffortLevel,
  type FastModeDisabledReason,
  type FastModeState,
  type ImageAttachment,
  type Mention,
  type PermissionMode,
} from '../../../shared/protocol.js'
import { useAttachments } from '../attachments.js'
import { activeMention, insertMention, useMentionSearch, useMentions, type MentionHit } from '../mentions.js'
import { nextMode } from '../permissionModes.js'
import { AttachmentStrip } from './AttachmentStrip.js'
import { FastModeToggle } from './FastModeToggle.js'
import { MentionPicker, flatHits } from './MentionPicker.js'
import { ModelPopover } from './ModelPopover.js'
import { PermissionModePicker } from './PermissionModePicker.js'

type Props = {
  /** The header row: which project, which branch, which folder. */
  head: ReactNode
  /** The folder `@file` mentions are searched in and resolved against. */
  cwd: string
  text: string
  onTextChange: (text: string) => void
  placeholder: string
  /** When this changes the box is refocused with the caret at the end. */
  focusKey?: string
  /** Called with the trimmed text and whatever is attached: images, `@` mentions. */
  onSubmit: (text: string, images?: ImageAttachment[], mentions?: Mention[]) => void
  sendTitle: string
  model?: string
  effort?: EffortLevel
  fastMode?: boolean
  fastModeState?: FastModeState
  fastModeDisabledReason?: FastModeDisabledReason
  permissionMode?: PermissionMode
  onModelChange: (model: string | undefined, effort: EffortLevel | undefined) => void
  onFastModeChange: (fastMode: boolean) => void
  onPermissionModeChange: (mode: PermissionMode) => void
  /** A turn is in flight — offer the interrupt button. */
  running?: boolean
  onInterrupt?: () => void
}

/**
 * The prompt box, shared by the draft tab and the live session so the two are
 * the same object in two places: a card headed by where it runs, a tray of
 * attached images and `@` mentions, the message, and the session's knobs as
 * pills underneath with the one bright control on the page — send.
 *
 * Typing `@` opens the mention picker over the box: files under the folder,
 * work items, sessions. The picker never takes focus; the box's key handler
 * moves the selection while the keystrokes keep narrowing the query.
 */
export function PromptBox({
  head,
  cwd,
  text,
  onTextChange,
  placeholder,
  focusKey,
  onSubmit,
  sendTitle,
  model,
  effort,
  fastMode,
  fastModeState,
  fastModeDisabledReason,
  permissionMode,
  onModelChange,
  onFastModeChange,
  onPermissionModeChange,
  running,
  onInterrupt,
}: Props) {
  const box = useRef<HTMLTextAreaElement>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const attach = useAttachments()
  const mentions = useMentions()

  // --- the `@` picker ------------------------------------------------------
  const [caret, setCaret] = useState(0)
  // Escape closes the picker for the token being typed; a new `@` reopens it.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const [sel, setSel] = useState(0)
  const active = useMemo(() => activeMention(text, caret), [text, caret])
  const pickerOpen = active !== null && dismissedAt !== active.start
  const groups = useMentionSearch(pickerOpen ? active : null, cwd, mentions.mentions)
  const hits = useMemo(() => flatHits(groups), [groups])

  useEffect(() => setSel(0), [active?.query, active?.kind])
  useEffect(() => {
    if (active === null) setDismissedAt(null)
  }, [active])

  const syncCaret = useCallback(() => {
    const el = box.current
    if (el) setCaret(el.selectionStart ?? el.value.length)
  }, [])

  const pick = useCallback(
    (h: MentionHit) => {
      if (!active) return
      const next = insertMention(text, active, h)
      mentions.add(h)
      onTextChange(next.text)
      // Land the caret after the token once React has painted the new value.
      requestAnimationFrame(() => {
        const el = box.current
        if (!el) return
        el.focus()
        el.setSelectionRange(next.caret, next.caret)
        setCaret(next.caret)
      })
    },
    [active, text, mentions, onTextChange],
  )

  const removeMention = useCallback(
    (m: Mention) => {
      mentions.remove(m)
      // The chip and the token are one thing: dropping the chip drops the text.
      const token = mentionToken(m)
      const i = text.indexOf(token)
      if (i >= 0) onTextChange(text.slice(0, i) + text.slice(i + token.length).replace(/^ /, ''))
    },
    [mentions, text, onTextChange],
  )

  // --- the box -------------------------------------------------------------
  const autosize = useCallback(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 320) + 'px'
  }, [])

  useEffect(autosize, [text, autosize])

  useEffect(() => {
    const el = box.current
    if (!el) return
    el.focus()
    // Land the caret at the end — a dispatched draft arrives prefilled.
    el.setSelectionRange(el.value.length, el.value.length)
    setCaret(el.value.length)
  }, [focusKey])

  function submit() {
    const trimmed = text.trim()
    const images = attach.payload()
    const picked = mentions.payload(trimmed)
    if (!trimmed && !images) return
    onSubmit(trimmed, images, picked)
    attach.clear()
    mentions.clear()
    requestAnimationFrame(autosize)
  }

  return (
    <div id="composer">
      <div
        className={'frame card' + (dragging ? ' dragging' : '')}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setDragging(false)
          void attach.add(e.dataTransfer.files)
        }}
      >
        <div className="cardHead">{head}</div>

        <AttachmentStrip
          images={attach.images}
          mentions={mentions.mentions}
          error={attach.error}
          onRemove={attach.remove}
          onRemoveMention={removeMention}
        />

        <MentionPicker open={pickerOpen} groups={groups} selected={sel} onHover={setSel} onPick={pick}>
          <textarea
            id="box"
            ref={box}
            autoFocus
            rows={1}
            value={text}
            placeholder={placeholder}
            onPaste={attach.onPaste}
            onChange={(e) => {
              onTextChange(e.target.value)
              setCaret(e.target.selectionStart ?? e.target.value.length)
            }}
            onSelect={syncCaret}
            onClick={syncCaret}
            onKeyUp={(e) => {
              if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') syncCaret()
            }}
            onKeyDown={(e) => {
              if (pickerOpen) {
                if (e.key === 'ArrowDown' && hits.length) {
                  e.preventDefault()
                  setSel((s) => (s + 1) % hits.length)
                  return
                }
                if (e.key === 'ArrowUp' && hits.length) {
                  e.preventDefault()
                  setSel((s) => (s - 1 + hits.length) % hits.length)
                  return
                }
                if ((e.key === 'Enter' || e.key === 'Tab') && hits.length) {
                  e.preventDefault()
                  pick(hits[Math.min(sel, hits.length - 1)])
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setDismissedAt(active?.start ?? null)
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              } else if (e.key === 'Tab' && e.shiftKey) {
                // Claude Code's own gesture, and the composer is where the
                // hands already are — so it lives here rather than in the
                // global map, which ignores keys typed into a text field.
                e.preventDefault()
                onPermissionModeChange(nextMode(permissionMode))
              }
            }}
          />
        </MentionPicker>

        <div className="statusline">
          <input
            ref={filePicker}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void attach.add(e.target.files)
              // Reset, so picking the same file twice in a row still fires.
              e.target.value = ''
            }}
          />
          <button
            className="chip attachBtn"
            onClick={() => filePicker.current?.click()}
            title="Attach images (or paste / drop them) · type @ to attach files, work items, sessions"
            aria-label="Attach images"
          >
            <ImagePlus aria-hidden="true" />
          </button>
          <ModelPopover model={model} effort={effort} onModelChange={onModelChange} />
          <PermissionModePicker mode={permissionMode} onChange={onPermissionModeChange} />
          <span className="spacer" />
          <FastModeToggle
            model={model}
            fastMode={fastMode}
            state={fastModeState}
            reason={fastModeDisabledReason}
            onChange={onFastModeChange}
          />
          {running && onInterrupt && (
            <button id="stopBtn" onClick={onInterrupt} title="Interrupt the current turn" aria-label="Stop">
              <Square size={11} aria-hidden="true" />
            </button>
          )}
          <button
            id="sendBtn"
            onClick={submit}
            disabled={!text.trim() && attach.images.length === 0}
            title={sendTitle}
          >
            <ArrowUp size={15} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  )
}
