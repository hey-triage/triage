/**
 * Watches — user-defined ingestion rules (.docs/watches.md). A watch is one
 * plain-English sentence, scoped to a place, that tells the scanner what the
 * user cares about. Server-managed config rows → SQLite (storage rule).
 */

export type WatchCadence = 'hourly' | 'daily' | 'weekly'

/**
 * A connector a watch run may use. This is the real fence: the run's tool
 * allowlist is composed from these (read-only tools per connector, see
 * connectors.ts). Where to look inside a connector lives in the instruction.
 */
export type WatchConnector = 'slack' | 'linear' | 'github' | 'web'

/**
 * What a run produces. `items`: one work item per match, deduped by the link
 * it passes. `digest`: ONE rolling work item per watch with a markdown report
 * attached; each run rewrites the report and the item returns to the inbox.
 */
export type WatchOutput = 'items' | 'digest'
export const WATCH_OUTPUTS: WatchOutput[] = ['items', 'digest']
export const WATCH_CONNECTORS: WatchConnector[] = ['web', 'slack', 'linear', 'github']

/** The outcome of one watch run (.docs/watches-v2.md). */
export type WatchRunStatus = 'ok' | 'failed' | 'skipped'

export interface Watch {
  id: string
  /** v0.2: slack only (connector-neutral machinery; Slack lives in the prompt) */
  source: 'slack'
  /** "PX topics in #novus-px" */
  title: string
  /**
   * Legacy (pre-connectors) place hint: '#channel' | '@dm'. Empty for watches
   * created since; kept so old rows still say where they used to look.
   */
  scope: string
  /** the NL instructions: where to look and what counts; editable forever */
  instruction: string
  /** connectors the run may use — its tool allowlist (never empty) */
  connectors: WatchConnector[]
  /** optional project: the run gets its folder as cwd plus read-only code tools */
  projectId?: string
  /** model alias or wire id for the run; omitted = Claude Code's own default */
  model?: string
  /** items (default) or one rolling digest with a report */
  output: WatchOutput
  /**
   * A 5-field cron expression, the source of truth for when the watch runs
   * (.docs/watches-v2.md). Legacy rows without one derive it from `cadence`.
   */
  schedule: string
  /** legacy coarse cadence; retained for back-compat / draft suggestions */
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

export type NewWatch = Pick<Watch, 'title' | 'instruction' | 'schedule' | 'createsItems' | 'connectors'> & {
  /** legacy place hint; new watches leave it empty */
  scope?: string
  projectId?: string
  model?: string
  output?: WatchOutput
  /** legacy; defaults to a coarse bucket when omitted */
  cadence?: WatchCadence
  windowStart?: string
  windowDay?: number
}

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
  /** the canonical id the real run would file under */
  id: string
  title: string
  url: string
  place: string
  from: string
  lastActivity: string
  why: string
}

/** What a dry run returns: the would-be items or the would-be digest, and what it cost. Nothing is saved. */
export interface WatchPreviewResult {
  output: WatchOutput
  rows: WatchPreviewRow[]
  digest?: { title: string; body: string }
  tokens: number
  costUsd?: number
  durationMs: number
}
