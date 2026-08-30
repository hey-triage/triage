import { useEffect, useRef } from 'react'
import { MOD_LABEL } from '../keys.js'

const SHORTCUTS: Array<[string, string]> = [
  [`${MOD_LABEL}K`, 'Command center'],
  ['n', 'New session'],
  ['g i', 'Go to Inbox'],
  ['g w', 'Go to Watches'],
  ['g p', 'Go to Projects'],
  ['g c', 'Go to Connectors'],
  ['j / k', 'Inbox: move selection'],
  ['Enter / o', 'Inbox: open selected item'],
  ['d', 'Inbox: dispatch selected item'],
  ['e', 'Inbox: mark selected item done'],
  ['z', 'Inbox: snooze selected item until tomorrow'],
  ['x', 'Inbox: dismiss selected item (never returns)'],
  ['r', 'Inbox: refresh'],
  ['?', 'This help'],
  ['Esc', 'Close dialogs'],
]

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
