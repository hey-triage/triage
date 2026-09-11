import { ArrowUp, ImagePlus, Square } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import type {
  EffortLevel,
  ImageAttachment,
  FastModeDisabledReason,
  FastModeState,
  PermissionMode,
  SessionStatus,
} from '../../../shared/protocol.js'
import { useAttachments } from '../attachments.js'
import { nextMode } from '../permissionModes.js'
import { AttachmentStrip } from './AttachmentStrip.js'
import { FastModeToggle } from './FastModeToggle.js'
import { ModelPopover } from './ModelPopover.js'
import { PermissionModePicker } from './PermissionModePicker.js'

type Props = {
  status: SessionStatus
  model?: string
  effort?: EffortLevel
  fastMode?: boolean
  fastModeState?: FastModeState
  fastModeDisabledReason?: FastModeDisabledReason
  permissionMode?: PermissionMode
  onSend: (text: string, images?: ImageAttachment[]) => void
  onInterrupt: () => void
  onModelChange: (model: string | undefined, effort: EffortLevel | undefined) => void
  onFastModeChange: (fastMode: boolean) => void
  onPermissionModeChange: (mode: PermissionMode) => void
}

/**
 * The session composer: a card with the message on top and the session's
 * knobs as pills underneath — model, fast mode, how much it asks — and the one
 * bright control on the page, the send button.
 */
export function Composer({
  status,
  model,
  effort,
  fastMode,
  fastModeState,
  fastModeDisabledReason,
  permissionMode,
  onSend,
  onInterrupt,
  onModelChange,
  onFastModeChange,
  onPermissionModeChange,
}: Props) {
  const [text, setText] = useState('')
  const [dragging, setDragging] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  const attach = useAttachments()
  const running = status === 'running' || status === 'starting'

  const autosize = useCallback(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [])

  function submit() {
    const trimmed = text.trim()
    const images = attach.payload()
    if (!trimmed && !images) return
    onSend(trimmed, images)
    setText('')
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
        <AttachmentStrip images={attach.images} error={attach.error} onRemove={attach.remove} />
        <textarea
          id="box"
          ref={box}
          autoFocus
          rows={1}
          value={text}
          placeholder={running ? 'Steer the session… (queued until this turn ends)' : 'Steer the session…'}
          onPaste={attach.onPaste}
          onChange={(e) => {
            setText(e.target.value)
            autosize()
          }}
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
          {running && (
            <button id="stopBtn" onClick={onInterrupt} title="Interrupt the current turn" aria-label="Stop">
              <Square size={11} aria-hidden="true" />
            </button>
          )}
          <button
            id="sendBtn"
            onClick={submit}
            disabled={!text.trim() && attach.images.length === 0}
            title="Send (Enter)"
          >
            <ArrowUp size={15} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  )
}
