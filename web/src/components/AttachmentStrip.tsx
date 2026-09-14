import { X } from 'lucide-react'
import type { Mention } from '../../../shared/protocol.js'
import { MentionChip } from './MentionPicker.js'

/**
 * Anything with a preview: a `PendingImage` being uploaded, or an image a work
 * item already holds (`itemImageUrl`). The strip only needs a key and a src.
 */
export type StripImage = { id: string; url: string; name?: string }

type Props = {
  images: readonly StripImage[]
  mentions?: readonly Mention[]
  error: string | null
  onRemove: (id: string) => void
  onRemoveMention?: (m: Mention) => void
}

/** What's attached to the message being written, above the box: image thumbnails and `@` chips. */
export function AttachmentStrip({ images, mentions = [], error, onRemove, onRemoveMention }: Props) {
  if (images.length === 0 && mentions.length === 0 && !error) return null
  return (
    <div className="attachments">
      {images.length > 0 && (
        <div className="thumbs">
          {images.map((img) => (
            <div className="thumb" key={img.id}>
              <img src={img.url} alt={img.name ?? 'Attached image'} />
              <button
                className="drop"
                onClick={() => onRemove(img.id)}
                title="Remove"
                aria-label={`Remove ${img.name ?? 'image'}`}
              >
                <X size={10} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
      {mentions.length > 0 && (
        <div className="mchips">
          {mentions.map((m) => (
            <MentionChip key={`${m.kind}:${m.ref}`} m={m} onRemove={onRemoveMention ? () => onRemoveMention(m) : undefined} />
          ))}
        </div>
      )}
      {error && <div className="attachError">{error}</div>}
    </div>
  )
}
