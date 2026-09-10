/**
 * The WebSocket contract between the triage server and its frontends.
 *
 * This is the only thing a frontend is allowed to know about the server —
 * "thin frontends, fat core" (see .docs/vision.md). Both `server/` and `web/`
 * import this file, so a change to the wire format is a compile error on the
 * side that did not keep up.
 */

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

import type { WatchRunStatus } from '../core/watch/types.js'

export type SessionStatus = 'starting' | 'idle' | 'running' | 'error'

// ---------------------------------------------------------------------------
// Workspaces (.docs/workspaces.md) — the top-level scope isolating work from
// personal. Each workspace has its own DB (projects, inbox, watches, sessions)
// and its own Claude auth backend. Every HTTP request and WS connection is
// bound to exactly one workspace (?workspace= param, else the triage_ws
// cookie, else the default).
// ---------------------------------------------------------------------------

/**
 * How a workspace's Claude subprocesses authenticate:
 * - `inherit` — no overrides; the machine's own ~/.claude login (and its
 *   claude.ai connectors), exactly like before workspaces existed.
 * - `api-key` — spawned with ANTHROPIC_API_KEY from the workspace's .env.
 *   Billed to the key; NO claude.ai connectors (they ride the claude.ai
 *   login), so Slack watches don't run here. `gh` is unaffected.
 * - `config-dir` — spawned with CLAUDE_CONFIG_DIR pointing into the workspace:
 *   a separate claude.ai login with its own subscription and connectors.
 *   Needs a one-time interactive login (see `loginCommand`).
 */
export type WorkspaceAuthBackend = 'inherit' | 'api-key' | 'config-dir'

export type Workspace = {
  id: string
  name: string
  /** hex color — the ambient "which world am I in" signal in the UI */
  color: string
  description?: string
  authBackend: WorkspaceAuthBackend
  isDefault: boolean
  /** api-key backend: masked tail of the stored key ("…abcd"); null = none yet */
  apiKeyHint?: string | null
  /** config-dir backend: where that login lives, and the one-time login command */
  configDir?: string
  loginCommand?: string
  createdAt: number
}

export type WorkspacesResponse =
  | { ok: true; workspaces: Workspace[]; defaultId: string; onboarded: boolean }
  | { ok: false; error: string }

export type WorkspaceResponse = { ok: true; workspace: Workspace } | { ok: false; error: string }

/**
 * POST /api/workspaces/verify — a live probe with the workspace's own env.
 * `authOk` is a real auth check (a one-turn headless prompt) for api-key and
 * config-dir backends — the model catalog alone doesn't prove a key works.
 * For `inherit` it is always true (that login is the machine's own).
 */
export type WorkspaceVerifyResponse =
  | {
      ok: true
      models: ModelOption[]
      connectors: Connector[]
      slackConnected: boolean
      authOk: boolean
      authError?: string
    }
  | { ok: false; error: string }

/**
 * What kind of session a row is. `chat` = a normal user conversation (the
 * default). `watch-run` = one watch's scan, run as a real session so its
 * transcript is the run's observability (.docs/watches-v2.md); the sidebar
 * filters these out of the chat list.
 */
export type SessionKind = 'chat' | 'watch-run'

/**
 * What the user did with one prompt. `allow_always` is `allow` plus the SDK's
 * own "don't ask again" suggestions, scoped to this session — the narrow way
 * to stop being asked, as against turning the whole session permissive.
 */
export type PermissionBehavior = 'allow' | 'allow_always' | 'deny'

/**
 * How much the session asks before acting. Mostly a subset of the SDK's own
 * `PermissionMode` — the ones that answer "how often am I interrupted" — plus
 * one triage-native mode:
 *
 * - `'default' | 'acceptEdits' | 'auto' | 'bypassPermissions'` are the SDK's,
 *   passed straight through. ('plan' and 'dontAsk' are the SDK's other two —
 *   deliberately not offered, they change what the agent does, not how much it
 *   asks.)
 * - `'gated'` is ours: reads and lookups run without asking; anything that
 *   writes — a file, the shell, or an outward connector call — still prompts.
 *   The SDK has no equivalent, so the server runs at its `'default'` and
 *   enforces the gate itself in `canUseTool` (see `ToolEffect`), which a
 *   subprocess cannot opt out of.
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'gated'

/**
 * A tool's blast radius, as the server classifies it before deciding whether
 * `'gated'` mode lets it run unattended:
 *
 * - `read` — reads/lookups only (file reads, greps, `list_work_items`, and
 *   connector calls whose name is clearly a read). Auto-allowed under `gated`.
 * - `local-write` — side effects confined to this machine (file edits, shell,
 *   the triage inbox's own writes).
 * - `external-write` — a call that reaches outside this machine (post to
 *   Slack, open a Jira/Linear/GitHub item, …).
 *
 * Under `gated`, only `read` runs unattended; the other two prompt. Surfaced
 * on the permission card so a prompt says *why* it is asking.
 */
export type ToolEffect = 'read' | 'local-write' | 'external-write'

/** How much thinking the model puts into a turn. The SDK's own scale. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * Fast mode: the same model served at up to ~2.5x the output tokens/second,
 * at premium pricing. Off by default and chosen per session — speed you opt
 * into for a turn you are waiting on, not a setting to forget you left on.
 *
 * Two facts, deliberately kept apart: what the user asked for (`fastMode` on
 * the session) and what the subprocess reports it can actually do — the SDK
 * only serves fast mode on some models, some plans and some auth backends,
 * and says why when it cannot. Mirrors the SDK's own `FastModeState` /
 * `FastModeDisabledReason`, so a stale reason we no longer know renders as
 * plain unavailability rather than a lie.
 */
export type FastModeState = 'off' | 'cooldown' | 'on'

export type FastModeDisabledReason =
  | 'free'
  | 'preference'
  | 'extra_usage_disabled'
  | 'network_error'
  | 'unknown'
  | 'not_first_party'
  | 'disabled_by_env'
  | 'model_not_allowed'
  | 'sdk_opt_in_required'
  | 'pending'

export type SessionSummary = {
  id: string
  title: string
  cwd: string
  status: SessionStatus
  /** The chosen model when the user picked one, else what the SDK reported. */
  model?: string
  /** The chosen effort, when the user picked one. */
  effort?: EffortLevel
  /** Fast mode as the user set it. Absent = off. */
  fastMode?: boolean
  /** What fast mode is actually doing, as the live subprocess last reported. */
  fastModeState?: FastModeState
  /** Why fast mode cannot serve right now. Absent = nothing is blocking it. */
  fastModeDisabledReason?: FastModeDisabledReason
  /** How much this session asks before acting. Absent = 'default'. */
  permissionMode?: PermissionMode
  /** Pinned to the top of the sidebar. Absent = not pinned. */
  pinned?: boolean
  /** Current git branch of `cwd`, when it is a repo. Derived, not stored. */
  branch?: string
  /** chat (default, absent) or watch-run. */
  kind?: SessionKind
  /** the watch a watch-run session belongs to. */
  watchId?: string
}

// ---------------------------------------------------------------------------
// Agent SDK payloads
//
// The server forwards Agent SDK messages verbatim. Rather than mirror the SDK's
// full type surface into the browser (it is a node-only package), these types
// describe exactly the subset the UI reads — everything else stays untyped and
// is ignored. Widen these as the UI starts reading more.
// ---------------------------------------------------------------------------

/** A content block as it arrives on the wire: `type` plus unknown extras. */
export type RawBlock = { type: string } & Record<string, unknown>

export type TextBlock = { type: 'text'; text: string }
export type ThinkingBlock = { type: 'thinking'; thinking: string }
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
export type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content: string | RawBlock[] | unknown
  is_error?: boolean
}

export const isTextBlock = (b: RawBlock): b is RawBlock & TextBlock =>
  b.type === 'text' && typeof b.text === 'string'

export const isThinkingBlock = (b: RawBlock): b is RawBlock & ThinkingBlock =>
  b.type === 'thinking' && typeof b.thinking === 'string'

export const isToolUseBlock = (b: RawBlock): b is RawBlock & ToolUseBlock =>
  b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string'

export const isToolResultBlock = (b: RawBlock): b is RawBlock & ToolResultBlock =>
  b.type === 'tool_result' && typeof b.tool_use_id === 'string'

export type McpServerInfo = { name: string; status: string }

// ---------------------------------------------------------------------------
// Connectors (GET /api/connectors)
//
// The claude.ai connectors + local MCP servers a session will load, probed by
// spawning a throwaway SDK query with the same options real sessions use and
// reading its init message. HTTP rather than WS: it is request/response data.
// ---------------------------------------------------------------------------

export type ConnectorSource = 'claude.ai' | 'local'

export type Connector = {
  /** Display name — "claude.ai " prefix already stripped for claude.ai ones. */
  name: string
  status: string
  source: ConnectorSource
}

export type ConnectorsResponse =
  | { ok: true; probedAt: number; connectors: Connector[] }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Models (GET /api/models)
//
// What this machine's Claude Code will actually run, asked of the SDK itself
// (supportedModels()) rather than hardcoded — the catalog changes under us,
// and an org policy can shrink it. Same shape of probe as the connectors one.
// ---------------------------------------------------------------------------

export type ModelOption = {
  /** What to pass as `model` — an alias ('sonnet') or a wire id. */
  id: string
  /** The wire id `id` resolves to; lets a reported model match its alias row. */
  resolvedModel?: string
  /** "Opus (1M context)" */
  name: string
  /** One line under the name in the picker. */
  description: string
  /** Effort levels this model accepts; empty when it has no effort control. */
  efforts: EffortLevel[]
  /** Whether this model can be run in fast mode at all. */
  supportsFastMode?: boolean
}

export type ModelsResponse =
  | { ok: true; probedAt: number; models: ModelOption[] }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Inbox (GET /api/inbox)
//
// Ranked work items. The domain types live in core/work/types.ts (fat core);
// re-exported here so frontends keep importing one contract file.
// ---------------------------------------------------------------------------

export type { Group, ItemKind, Provenance, ScoredItem, WorkItem, WorkSource } from '../core/work/types.js'

export type InboxSnapshot = {
  syncedAt: number
  items: import('../core/work/types.js').ScoredItem[]
  notices: string[]
}

export type InboxResponse = ({ ok: true } & InboxSnapshot) | { ok: false; error: string }

// A status tab other than the open inbox (done / snoozed / archived). Ranked
// like the inbox but read straight from the durable store — no scan, no cache.
export type ItemListResponse =
  | { ok: true; items: import('../core/work/types.js').ScoredItem[] }
  | { ok: false; error: string }

// The append-only transition log for one item (GET /api/items/events?id=…).
export type { ItemEvent, ItemEventKind } from '../core/work/state.js'

export type ItemEventsResponse =
  | { ok: true; events: import('../core/work/state.js').ItemEvent[] }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Activity (GET /api/activity) — watch runs, each a real session, as a browsable
// history. Each run links to the transcript (its sessionId) and its produced
// items (.docs/watches-v2.md).
// ---------------------------------------------------------------------------
export type ActivityRun = {
  sessionId: string
  watchId?: string
  watchTitle: string
  status?: WatchRunStatus
  matches?: number
  tokens?: number
  startedAt: number
  finishedAt: number
  error?: string
}

export type ActivityResponse =
  | { ok: true; runs: ActivityRun[] }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Coverage probe (GET /api/coverage?scope=…) — the trust ritual: is this channel
// watched, and are its watches healthy? (.docs/watches-v2.md)
// ---------------------------------------------------------------------------
export type CoverageWatch = {
  id: string
  title: string
  scope: string
  enabled: boolean
  lastRunStatus?: WatchRunStatus
  lastRunAt?: number
  cursor?: string
}

export type CoverageResponse =
  | { ok: true; scope: string; watches: CoverageWatch[] }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// System / daemon status + logs (GET /api/system, GET /api/logs) — the gateway
// status surface: is the daemon up, is the scheduler ticking, are connectors
// live, and its recent activity log.
// ---------------------------------------------------------------------------
export type SystemStatus = {
  version: string
  startedAt: number
  uptimeMs: number
  port: number
  /** the workspace this status describes (statuses are per-workspace) */
  workspace: string
  db: string
  liveSessions: number
  /** true/false, or null when the connector probe hasn't landed yet */
  slackConnected: boolean | null
  connectorsProbedAt: number | null
  connectorCount: number | null
  schedulerLastTickAt: number | null
  runningWatches: number
  inboxSyncedAt: number | null
  githubReconcileAt: number | null
  githubNotice: string | null
  watches: { total: number; enabled: number; overdue: number; failing: number }
  /** where JSONL log files are written, or null if file logging is off */
  logDir: string | null
}

export type SystemResponse = { ok: true; status: SystemStatus } | { ok: false; error: string }

export type LogLevel = 'info' | 'warn' | 'error'
export type LogEntry = {
  seq: number
  ts: number
  level: LogLevel
  subsystem: string
  message: string
  /** optional machine-readable context (ids, counts, durations) */
  fields?: Record<string, unknown>
}
export type LogsResponse =
  | { ok: true; entries: LogEntry[]; subsystems: string[] }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Connected repos (GET /api/repos, PUT /api/repos)
//
// The repos the GitHub source is scoped to, per workspace. Empty = NO GitHub
// items (.docs/workspaces.md): scope is opt-in per workspace so the same PRs
// don't mirror into every inbox. Pick the repos each workspace should track.
// ---------------------------------------------------------------------------

export type ReposResponse =
  | { ok: true; connected: string[]; available: string[] }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Projects (GET/POST/DELETE /api/projects)
//
// A project names a local working folder, optionally tied to a GitHub repo.
// Selecting one runs sessions in that folder; dispatch matches a work item's
// repo to a project to land in the right folder automatically.
// ---------------------------------------------------------------------------

export type Project = {
  id: string
  name: string
  /** owner/name; empty when the project isn't tied to a repo */
  repo: string
  /** absolute local folder sessions run in */
  path: string
}

export type ProjectsResponse =
  | { ok: true; projects: Project[] }
  | { ok: false; error: string }

// POST /api/pick-folder — opens the OS's native folder chooser on the machine
// running the server (which is the user's own machine) and returns the picked
// absolute path. `cancelled` is the user dismissing the dialog, not an error.
export type PickFolderResponse =
  | { ok: true; path: string }
  | { ok: true; cancelled: true }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Watches (GET/POST/PUT/DELETE /api/watches, POST /api/watches/draft,
// POST /api/watches/preview) — the ingestion engine (.docs/watches.md).
// Domain types live in core/watch/types.ts; type-only re-exports, so nothing
// server-side leaks into the browser bundle.
// ---------------------------------------------------------------------------

export type { NewWatch, Watch, WatchCadence, WatchDraft, WatchPreviewRow, WatchRunStatus } from '../core/watch/types.js'

export type WatchesResponse =
  | { ok: true; watches: import('../core/watch/types.js').Watch[] }
  | { ok: false; error: string }

export type WatchDraftResponse =
  | { ok: true; draft: import('../core/watch/types.js').WatchDraft }
  | { ok: false; error: string }

export type WatchPreviewResponse =
  | { ok: true; rows: import('../core/watch/types.js').WatchPreviewRow[]; tokens: number }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Item state (POST /api/items/state) — the user-state overlay: done, snoozed,
// dismissed. Ingestion never writes it; the re-arm rule reopens items in code.
// ---------------------------------------------------------------------------

export type { ItemStatus } from '../core/work/state.js'

export type ItemStateResponse = { ok: true } | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Manual items (POST/PUT/DELETE /api/items/manual) — to-dos the user adds by
// hand in the inbox. Their own table; source/kind 'manual'. Also POST
// /api/items/priority — a user priority override for any item (source or manual).
// ---------------------------------------------------------------------------

export type ManualItemInput = {
  title: string
  projectId?: string
  note?: string
  url?: string
  priority?: number
}

export type ManualItemResponse = { ok: true } | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Ingestion (POST /api/items/upsert, POST /api/items/resolve) — the contract
// that makes external scanners first-class; also served over MCP (server/mcp.ts).
// Idempotent: id-keyed, update-only-if-newer, user-state-preserving. Validates
// and rejects rather than repairs.
// ---------------------------------------------------------------------------

export type UpsertResponse =
  | { ok: true; outcome: 'inserted' | 'updated' | 'unchanged' }
  | { ok: false; error: string }

/** A `stream_event`'s inner Anthropic streaming event (deltas only, for now). */
export type StreamEvent = {
  type: string
  delta?: { type: string; text?: string }
}

/** The subset of an SDK message the UI reads. */
export type SdkMessage = {
  type: string
  subtype?: string
  /** Claude Code's own session id — present on every SDK message. */
  session_id?: string
  model?: string
  tools?: string[]
  mcp_servers?: McpServerInfo[]
  message?: { role?: string; content?: RawBlock[] }
  event?: StreamEvent
  total_cost_usd?: number
  duration_ms?: number
  num_turns?: number
  /** Carried on init and result messages; the session's fast-mode reality. */
  fast_mode_state?: FastModeState
  fast_mode_disabled_reason?: FastModeDisabledReason
}

// ---------------------------------------------------------------------------
// Session events (the replay log, and the live stream)
// ---------------------------------------------------------------------------

export type SessionEvent =
  | { kind: 'sdk'; message: SdkMessage }
  | { kind: 'local_user'; text: string }
  | { kind: 'error'; message: string }
  | {
      kind: 'permission_request'
      id: string
      toolName: string
      input: Record<string, unknown>
      title?: string
      description?: string
      /**
       * The SDK offered "don't ask again" rules for this call, so the card can
       * show that button. Not every prompt has them (a one-off path, say).
       */
      canAlwaysAllow?: boolean
      /** The tool's blast radius, so the card can say why it is asking. */
      effect?: ToolEffect
    }
  // 'expired' = the request outlived its subprocess (interrupt, crash, server
  // restart) and can no longer be answered.
  | {
      kind: 'permission_resolved'
      id: string
      behavior: PermissionBehavior | 'expired'
      /** What the user picked, when the prompt was an AskUserQuestion. */
      answers?: QuestionAnswers
    }

/**
 * The answers to an `AskUserQuestion` call: question text → the chosen option
 * label (multi-select joins its labels with ", "). Handed back to the tool as
 * `input.answers`, which is where Claude Code reads a picked answer from.
 */
export type QuestionAnswers = Record<string, string>

// ---------------------------------------------------------------------------
// Wire messages
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Terminals — PTY-backed shells the daemon runs for the browser. Ephemeral:
// they live in the daemon's memory and die with it, so nothing here is stored.
// ---------------------------------------------------------------------------

export type TerminalStatus = 'running' | 'exited'

export type TerminalSummary = {
  id: string
  title: string
  cwd: string
  /** the shell binary's basename, e.g. "zsh" */
  shell: string
  pid: number
  status: TerminalStatus
  exitCode?: number
  createdAt: number
}

export type ClientMessage =
  | {
      type: 'create_session'
      title: string
      cwd: string
      firstMessage?: string
      model?: string
      effort?: EffortLevel
      permissionMode?: PermissionMode
      fastMode?: boolean
    }
  /** Switch a session's model/effort — mid-session, and for every turn after. */
  | { type: 'set_model'; sessionId: string; model?: string; effort?: EffortLevel }
  /** Turn fast mode on or off — mid-session, and for every turn after. */
  | { type: 'set_fast_mode'; sessionId: string; fastMode: boolean }
  /** Switch how much a session asks — mid-session, and for every turn after. */
  | { type: 'set_permission_mode'; sessionId: string; mode: PermissionMode }
  /** Give a session a new title. */
  | { type: 'rename_session'; sessionId: string; title: string }
  /** Pin a session to the top of the list, or unpin it. */
  | { type: 'set_pinned'; sessionId: string; pinned: boolean }
  /** Delete a session and its transcript. Irreversible — the UI confirms. */
  | { type: 'delete_session'; sessionId: string }
  | { type: 'subscribe'; sessionId: string }
  | { type: 'user_message'; sessionId: string; text: string }
  | {
      type: 'permission_response'
      sessionId: string
      requestId: string
      behavior: PermissionBehavior
      /** Set only for AskUserQuestion prompts — folded into the tool's input. */
      answers?: QuestionAnswers
    }
  | { type: 'interrupt'; sessionId: string }
  /** Open a shell in `cwd` (default: the home folder); `command` is typed in first, if given. */
  | { type: 'terminal_create'; cwd?: string; title?: string; command?: string }
  /** Keystrokes / pasted text — raw, exactly as the terminal emulator produced them. */
  | { type: 'terminal_input'; terminalId: string; data: string }
  | { type: 'terminal_resize'; terminalId: string; cols: number; rows: number }
  /** Replay the scrollback buffer to this socket, then stream. */
  | { type: 'terminal_subscribe'; terminalId: string }
  | { type: 'terminal_rename'; terminalId: string; title: string }
  /** Kill the process (if still running) and forget the terminal. */
  | { type: 'terminal_close'; terminalId: string }

export type ServerMessage =
  // hello also carries the workspace picture: which one this socket is bound
  // to, every workspace's card for the switcher, and whether first-run
  // onboarding has been completed.
  | {
      type: 'hello'
      sessions: SessionSummary[]
      workspaceId: string
      workspaces: Workspace[]
      onboarded: boolean
      terminals: TerminalSummary[]
    }
  | { type: 'sessions'; sessions: SessionSummary[] }
  | { type: 'session_created'; session: SessionSummary }
  | { type: 'session_deleted'; sessionId: string }
  | { type: 'history'; sessionId: string; events: SessionEvent[] }
  | { type: 'session_event'; sessionId: string; event: SessionEvent }
  | { type: 'terminals'; terminals: TerminalSummary[] }
  | { type: 'terminal_created'; terminal: TerminalSummary }
  /** The scrollback so far — sent once per subscribe, before live output resumes. */
  | { type: 'terminal_history'; terminalId: string; data: string }
  | { type: 'terminal_output'; terminalId: string; data: string }
  | { type: 'terminal_exit'; terminalId: string; exitCode: number }
  | { type: 'terminal_closed'; terminalId: string }
  | { type: 'error'; message: string }
