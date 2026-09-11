import { ArrowUp, ImagePlus, Square } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type {
  EffortLevel,
  FastModeDisabledReason,
  FastModeState,
  ImageAttachment,
  PermissionMode,
} from '../../../shared/protocol.js'
import { useAttachments } from '../attachments.js'
import { nextMode } from '../permissionModes.js'
import { AttachmentStrip } from './AttachmentStrip.js'
import { FastModeToggle } from './FastModeToggle.js'
import { ModelPopover } from './ModelPopover.js'
import { PermissionModePicker } from './PermissionModePicker.js'

type Props = {
  /** The header row: which project, which branch, which folder. */
  head: ReactNode
  text: string
  onTextChange: (text: string) => void
  placeholder: string
  /** When this changes the box is refocused with the caret at the end. */
  focusKey?: string
  /** Called with the trimmed text and whatever images are attached. */
  onSubmit: (text: string, images?: ImageAttachment[]) => void
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
 * attached images, the message, and the session's knobs as pills underneath
 * with the one bright control on the page — send.
 */
export function PromptBox({
  head,
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
  }, [focusKey])

  function submit() {
    const trimmed = text.trim()
    const images = attach.payload()
    if (!trimmed && !images) return
    onSubmit(trimmed, images)
    attach.clear()
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

        <AttachmentStrip images={attach.images} error={attach.error} onRemove={attach.remove} />

        <textarea
          id="box"
          ref={box}
          autoFocus
          rows={1}
          value={text}
          placeholder={placeholder}
          onPaste={attach.onPaste}
          onChange={(e) => onTextChange(e.target.value)}
          onKeyDown={(e) => {
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
            title="Attach images (or paste / drop them)"
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
