/** Shared guards for global hotkeys. */

/** True when the event originates in a text-entry control — letter keys belong to it. */
export function isTypingTarget(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
}

/**
 * True while any <dialog> or popover menu is open — single-key hotkeys should
 * stay quiet, or "n" typed at an open menu starts a new session behind it.
 */
export function anyDialogOpen(): boolean {
  return document.querySelector('dialog[open], [data-popover-open]') !== null
}

export const isMac = navigator.platform.startsWith('Mac')
export const MOD_LABEL = isMac ? '⌘' : 'Ctrl+'
