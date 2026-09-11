import { X } from 'lucide-react'
import type { PendingImage } from '../attachments.js'

type Props = {
  images: PendingImage[]
  error: string | null
  onRemove: (id: string) => void
}

/** Thumbnails of what's attached to the message being written, above the box. */
export function AttachmentStrip({ images, error, onRemove }: Props) {
  if (images.length === 0 && !error) return null
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
      {error && <div className="attachError">{error}</div>}
    </div>
  )
}
