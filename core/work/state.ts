/**
 * User-state overlay (.docs/watches.md): the snapshot stays a replaced-
 * wholesale cache of what sources said; user state (done/snoozed/dismissed)
 * survives it in its own table keyed by item id. Ingestion never writes it —
 * the only ingestion-triggered transition is the re-arm rule, applied here.
 */
import type { WorkItem } from './types.js'

export type ItemStatus = 'open' | 'done' | 'snoozed' | 'dismissed'

export interface ItemState {
  itemId: string
  status: ItemStatus
  /** epoch ms of the last status change */
  statusAt: number
  /** epoch ms; only for status 'snoozed' */
  snoozeUntil?: number
  pinned: boolean
}

export interface OverlayResult {
  /** items the inbox should show, `returned` marked where re-armed */
  visible: WorkItem[]
  /** ids whose status must reset to 'open' in the store (re-arm rule) */
  rearmed: string[]
}

/**
 * Re-arm rule (code, deterministic): status 'done' — or a snooze that elapsed —
 * with source `updatedAt > statusAt` → open again, marked "returned". A plain
 * elapsed snooze also returns (that is what snooze means), without the marker
 * unless the item moved. Dismissed items never re-arm.
 */
export function applyOverlay(
  items: WorkItem[],
  states: Map<string, ItemState>,
  now = Date.now(),
): OverlayResult {
  const visible: WorkItem[] = []
  const rearmed: string[] = []
  for (const item of items) {
    const state = states.get(item.id)
    if (!state || state.status === 'open') {
      visible.push(item)
      continue
    }
    if (state.status === 'dismissed') continue
    const updatedSince = Date.parse(item.updatedAt) > state.statusAt
    if (state.status === 'done') {
      if (updatedSince) {
        visible.push({ ...item, returned: true })
        rearmed.push(item.id)
      }
      continue
    }
    // snoozed: back when the snooze elapses or the item moves
    const elapsed = state.snoozeUntil == null || now >= state.snoozeUntil
    if (elapsed || updatedSince) {
      visible.push(updatedSince ? { ...item, returned: true } : item)
      rearmed.push(item.id)
    }
  }
  return { visible, rearmed }
}
