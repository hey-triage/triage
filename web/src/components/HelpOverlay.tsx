import { useEffect, useRef } from 'react'
import { MOD_LABEL } from '../keys.js'

const SHORTCUTS: Array<[string, string]> = [
  [`${MOD_LABEL}K`, 'Search — sessions, items, projects, commands'],
  ['n', 'New session (in the inbox: new work item)'],
  ['Shift+Tab', 'Composer: cycle how much the session asks before acting'],
  ['g i', 'Go to Inbox'],
  ['g s', 'Go to Sessions'],
  ['g w', 'Go to Watches'],
  ['g p', 'Go to Projects'],
  ['g c', 'Go to Connectors'],
  ['j / k', 'Inbox: move selection'],
  ['Enter', 'Inbox: open the selected item'],
  ['o', 'Inbox: open the selected item at its source'],
  ['d', 'Inbox: dispatch selected item to a session'],
  ['e', 'Inbox: mark selected item done'],
  ['z', 'Inbox: snooze selected item until tomorrow'],
  ['x', 'Inbox: archive selected item'],
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
