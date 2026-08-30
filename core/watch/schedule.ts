/**
 * Due-checker, not cron (.docs/watches.md). No fire-time queue: a scheduler
 * tick asks "is it due?" against last_run_at. Missed runs execute on wake
 * (the first tick after boot/sleep finds them due) and coalesce structurally —
 * a watch that missed 9:00/10:00/11:00 is simply *due* at 12:00, once.
 */
import type { Watch } from './types.js'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** "HH:MM" onto a given day, local time. Malformed input falls back to 09:00. */
function atTime(day: Date, hhmm: string | undefined): Date {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? '')
  const h = m ? Math.min(23, Number(m[1])) : 9
  const min = m ? Math.min(59, Number(m[2])) : 0
  const d = new Date(day)
  d.setHours(h, min, 0, 0)
  return d
}

/** The most recent daily window boundary ≤ now (today@HH:MM, else yesterday's). */
function lastDailyWindow(now: Date, windowStart?: string): Date {
  const today = atTime(now, windowStart)
  return today.getTime() <= now.getTime() ? today : new Date(today.getTime() - DAY_MS)
}

/** The most recent weekly window boundary ≤ now (weekday@HH:MM). */
function lastWeeklyWindow(now: Date, windowDay: number | undefined, windowStart?: string): Date {
  const day = ((windowDay ?? 1) % 7 + 7) % 7 // default Monday; JS getDay convention
  const candidate = atTime(now, windowStart)
  candidate.setDate(candidate.getDate() - ((candidate.getDay() - day + 7) % 7))
  return candidate.getTime() <= now.getTime()
    ? candidate
    : new Date(candidate.getTime() - 7 * DAY_MS)
}

/**
 * Is this watch due right now? Pure — the caller runs it and sets lastRunAt.
 * A never-run watch is due immediately (its first scan covers recent history).
 */
export function isDue(w: Watch, now = new Date()): boolean {
  if (!w.enabled) return false
  if (w.lastRunAt == null) return true
  switch (w.cadence) {
    case 'hourly':
      return now.getTime() - w.lastRunAt >= HOUR_MS
    case 'daily':
      return w.lastRunAt < lastDailyWindow(now, w.windowStart).getTime()
    case 'weekly':
      return w.lastRunAt < lastWeeklyWindow(now, w.windowDay, w.windowStart).getTime()
  }
}
