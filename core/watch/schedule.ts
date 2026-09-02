/**
 * Due-checker, not cron daemon (.docs/watches-v2.md). No fire-time queue: each
 * scheduler tick asks "is it due?" against the watch's cron schedule and its
 * last run. Coalescing is structural — a watch that slept through several slots
 * is simply due once on the next tick, because `lastScheduled` returns the most
 * recent past slot and the run only fires while `lastRunAt` predates it. It
 * cannot fire multiple times for one missed window.
 */
import { cronFromCadence, lastScheduled } from './cron.js'
import type { Watch } from './types.js'

/** The watch's cron schedule, falling back to the legacy cadence for old rows. */
export function scheduleOf(w: Pick<Watch, 'schedule' | 'cadence' | 'windowStart' | 'windowDay'>): string {
  return w.schedule || cronFromCadence(w.cadence ?? 'daily', w.windowStart, w.windowDay)
}

/**
 * Is this watch due right now? Pure — the caller runs it and sets lastRunAt.
 * A never-run watch is due immediately (its first scan establishes the cursor).
 */
export function isDue(w: Watch, now = new Date()): boolean {
  if (!w.enabled) return false
  if (w.lastRunAt == null) return true
  const last = lastScheduled(scheduleOf(w), now.getTime())
  return last != null && w.lastRunAt < last
}
