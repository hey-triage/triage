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

export type SessionStatus = 'starting' | 'idle' | 'running' | 'error'

export type PermissionBehavior = 'allow' | 'deny'

export type SessionSummary = {
  id: string
  title: string
  cwd: string
  status: SessionStatus
  model?: string
  /** Current git branch of `cwd`, when it is a repo. Derived, not stored. */
  branch?: string
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
// Inbox (GET /api/inbox)
//
// Ranked work items. The domain types live in core/work/types.ts (fat core);
// re-exported here so frontends keep importing one contract file.
// ---------------------------------------------------------------------------

export type { Group, ItemKind, ScoredItem, WorkItem, WorkSource } from '../core/work/types.js'

export type InboxSnapshot = {
  syncedAt: number
  items: import('../core/work/types.js').ScoredItem[]
  notices: string[]
}

export type InboxResponse = ({ ok: true } & InboxSnapshot) | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Connected repos (GET /api/repos, PUT /api/repos)
//
// The repos the GitHub source is scoped to. Empty = all repos the account
// can see (noisy; the picker exists to narrow it).
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

// ---------------------------------------------------------------------------
// Watches (GET/POST/PUT/DELETE /api/watches, POST /api/watches/draft,
// POST /api/watches/preview) — the ingestion engine (.docs/watches.md).
// Domain types live in core/watch/types.ts; type-only re-exports, so nothing
// server-side leaks into the browser bundle.
// ---------------------------------------------------------------------------

export type { NewWatch, Watch, WatchCadence, WatchDraft, WatchPreviewRow } from '../core/watch/types.js'

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
    }
  // 'expired' = the request outlived its subprocess (interrupt, crash, server
  // restart) and can no longer be answered.
  | { kind: 'permission_resolved'; id: string; behavior: PermissionBehavior | 'expired' }

// ---------------------------------------------------------------------------
// Wire messages
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { type: 'create_session'; title: string; cwd: string; firstMessage?: string }
  | { type: 'subscribe'; sessionId: string }
  | { type: 'user_message'; sessionId: string; text: string }
  | {
      type: 'permission_response'
      sessionId: string
      requestId: string
      behavior: PermissionBehavior
    }
  | { type: 'interrupt'; sessionId: string }

export type ServerMessage =
  | { type: 'hello'; sessions: SessionSummary[] }
  | { type: 'sessions'; sessions: SessionSummary[] }
  | { type: 'session_created'; session: SessionSummary }
  | { type: 'history'; sessionId: string; events: SessionEvent[] }
  | { type: 'session_event'; sessionId: string; event: SessionEvent }
  | { type: 'error'; message: string }
