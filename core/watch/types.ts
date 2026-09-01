/**
 * Watches — user-defined ingestion rules (.docs/watches.md). A watch is one
 * plain-English sentence, scoped to a place, that tells the scanner what the
 * user cares about. Server-managed config rows → SQLite (storage rule).
 */

export type WatchCadence = 'hourly' | 'daily' | 'weekly'

/** The outcome of one watch run (.docs/watches-v2.md). */
export type WatchRunStatus = 'ok' | 'failed' | 'skipped'

export interface Watch {
  id: string
  /** v0.2: slack only (connector-neutral machinery; Slack lives in the prompt) */
  source: 'slack'
  /** "PX topics in #novus-px" */
  title: string
  /** '#channel' | '@dm' — code-enforced boundary the scan may not leave */
  scope: string
  /** the NL sentence; editable forever, never opaque weights */
  instruction: string
  cadence: WatchCadence
  /** daily/weekly: local time "09:00" */
  windowStart?: string
  /** weekly: 0-6 (JS getDay convention, Sunday = 0) */
  windowDay?: number
  enabled: boolean
  /** false = FYI-only rows (fyi kind, base score 5) */
  createsItems: boolean
  /** last-seen watermark: ISO ts of the newest scanned message window */
  cursor?: string
  /** epoch ms of the last run attempt (any status) */
  lastRunAt?: number
  /** what the last run cost/produced, surfaced in the watch list UI */
  lastRunTokens?: number
  lastRunMatches?: number
  /** the last run's outcome, so the list can show ok/failed honestly */
  lastRunStatus?: WatchRunStatus
  /** the session id of the last run, for opening its transcript */
  lastRunSessionId?: string
  /** the last run's error message, when it failed */
  lastRunError?: string
  /** the template this watch was seeded from (pre-installed as a copy), if any */
  templateId?: string
  createdAt: number
  updatedAt: number
}

export type NewWatch = Pick<
  Watch,
  'title' | 'scope' | 'instruction' | 'cadence' | 'windowStart' | 'windowDay' | 'createsItems'
>

/**
 * What one completed run attempt writes back to the row. `cursor` is set only
 * on a successful run — a failed/timed-out/skipped run must not advance the
 * watermark, or its window is skipped forever.
 */
export interface WatchRunResult {
  cursor?: string
  lastRunAt: number
  lastRunTokens: number
  lastRunMatches: number
  status: WatchRunStatus
  sessionId?: string
  error?: string
}

/** The draft step's parse of a plain-text wish — every field stays editable. */
export interface WatchDraft {
  title: string
  scope: string
  instruction: string
  cadence: WatchCadence
  createsItems: boolean
}

/** One thread a preview run would have matched, with its why-line. */
export interface WatchPreviewRow {
  title: string
  permalink: string
  channel: string
  from: string
  lastActivity: string
  why: string
}
