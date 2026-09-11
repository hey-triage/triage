import { useEffect, useRef } from 'react'
import { SHORTCUTS } from '../keys.js'

export function HelpOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])

  return (
    <dialog ref={dialog} id="helpOverlay" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <h3>Keyboard shortcuts</h3>
      <table>
        <tbody>
          {SHORTCUTS.map(([keys, what]) => (
            <tr key={keys}>
              <td>
                <kbd>{keys}</kbd>
              </td>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </dialog>
  )
}
