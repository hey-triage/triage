/**
 * triage-dev POC server
 *
 * Serves the web UI on :5178 and drives the locally installed Claude Code
 * via @anthropic-ai/claude-agent-sdk (subscription auth — no API key).
 *
 * Sessions are persisted to SQLite (core/store): the row + an append-only
 * event log (the same events the UI renders; stream deltas excluded). The
 * Claude subprocess itself is ephemeral — a session with no live subprocess
 * is revived on the next user message via the SDK's `resume`, keyed by the
 * sdk_session_id captured from the init message. The agent's own memory of
 * the conversation lives in ~/.claude's transcript, not here; our event log
 * is for rendering, never for re-feeding the model.
 *
 * The wire format lives in shared/protocol.ts and is shared with the frontend.
 */
import http from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import {
  query,
  type Query,
  type SDKUserMessage,
  type PermissionResult,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  ClientMessage,
  Connector,
  ConnectorsResponse,
  PermissionBehavior,
  SdkMessage,
  ServerMessage,
  SessionEvent,
  SessionStatus,
  SessionSummary,
} from '../shared/protocol.js'
import type {
  InboxResponse,
  InboxSnapshot,
  ItemStateResponse,
  Project,
  ProjectsResponse,
  ReposResponse,
  UpsertResponse,
  WatchDraftResponse,
  WatchPreviewResponse,
  WatchesResponse,
  WorkItem,
} from '../shared/protocol.js'
import { openSqliteStore } from '../core/store/sqlite.js'
import type { Store, StoredSession } from '../core/store/types.js'
import { refreshInbox } from '../core/work/inbox.js'
import { BASE } from '../core/work/score.js'
import { canonicalizeRefs } from '../core/work/link.js'
import type { ItemStatus } from '../core/work/state.js'
import { listAffiliatedRepos } from '../core/sources/github.js'
import { draftWatch, previewWatch, runSlackScan, type WatchScanSpec } from '../core/sources/slack.js'
import { isDue } from '../core/watch/schedule.js'
import type { NewWatch, Watch, WatchCadence } from '../core/watch/types.js'

const PORT = Number(process.env.PORT || 5178)
const DB_FILE = process.env.TRIAGE_DB || path.join(os.homedir(), '.triage', 'triage-dev.db')
const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** Vite build output — see vite.config.ts. Absent until `npm run build`. */
const WEB_DIR = path.join(__dirname, '..', 'dist', 'web')

const pExecFile = promisify(execFile)

// ---------------------------------------------------------------------------
// Async queue: lets us push user messages into the SDK's streaming input.
// ---------------------------------------------------------------------------
class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiters: ((r: IteratorResult<T>) => void)[] = []
  private closed = false

  push(item: T) {
    const w = this.waiters.shift()
    if (w) w({ value: item, done: false })
    else this.items.push(item)
  }

  close() {
    this.closed = true
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift()!, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((res) => this.waiters.push(res))
      },
    }
  }
}

// ---------------------------------------------------------------------------
// Live session: one running Claude subprocess bound to a stored session row.
// ---------------------------------------------------------------------------
class LiveSession {
  status: SessionStatus = 'starting'
  model?: string
  private seq: number
  private readonly input = new AsyncQueue<SDKUserMessage>()
  private readonly pendingPermissions = new Map<
    string,
    { input: Record<string, unknown>; resolve: (r: PermissionResult) => void }
  >()
  private readonly q: Query

  constructor(
    readonly row: StoredSession,
    lastSeq: number,
    resumeSdkSessionId: string | null,
  ) {
    this.seq = lastSeq
    this.q = query({
      prompt: this.input,
      options: {
        cwd: row.cwd,
        // Full Claude Code behavior: its system prompt + tools, and the
        // user's own settings/plugins/MCP connectors from ~/.claude.
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        includePartialMessages: true,
        // Revival: replay the agent's own transcript into the new subprocess.
        ...(resumeSdkSessionId ? { resume: resumeSdkSessionId } : {}),
        canUseTool: (toolName, toolInput, opts) =>
          this.requestPermission(toolName, toolInput, opts.title, opts.description),
      },
    })
    void this.pump()
  }

  private async pump() {
    try {
      for await (const msg of this.q) {
        const m = msg as unknown as SdkMessage
        if (m.type === 'system' && m.subtype === 'init') {
          this.model = m.model
          // The key for `resume` — without it a stored session can't continue.
          if (m.session_id && m.session_id !== this.row.sdkSessionId) {
            this.row.sdkSessionId = m.session_id
            void store.sessions.setSdkSessionId(this.row.id, m.session_id)
          }
          this.setStatus('idle')
        }
        if (m.type === 'assistant' || m.type === 'user') this.setStatus('running')
        // stream deltas are broadcast live but not persisted (recoverable
        // from the committed assistant message, and the only high-volume thing)
        this.emit({ kind: 'sdk', message: m }, m.type !== 'stream_event')
        if (m.type === 'result') {
          this.setStatus('idle')
          void store.sessions.touch(this.row.id)
          void refreshBranch(this.row)
        }
      }
      this.setStatus('idle')
    } catch (err) {
      this.emit({ kind: 'error', message: String(err) }, true)
      this.setStatus('error')
    } finally {
      // The subprocess is gone; any unanswered prompt can never be answered.
      this.expirePendingPermissions()
      live.delete(this.row.id)
      broadcastSessionList()
    }
  }

  sendUserMessage(text: string) {
    this.emit({ kind: 'local_user', text }, true)
    this.setStatus('running')
    void store.sessions.touch(this.row.id)
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
    } as SDKUserMessage
    this.input.push(msg)
  }

  private requestPermission(
    toolName: string,
    toolInput: Record<string, unknown>,
    title?: string,
    description?: string,
  ): Promise<PermissionResult> {
    const id = randomUUID()
    return new Promise<PermissionResult>((resolve) => {
      this.pendingPermissions.set(id, { input: toolInput, resolve })
      this.emit({ kind: 'permission_request', id, toolName, input: toolInput, title, description }, true)
    })
  }

  resolvePermission(id: string, behavior: PermissionBehavior) {
    const pending = this.pendingPermissions.get(id)
    if (!pending) return
    this.pendingPermissions.delete(id)
    if (behavior === 'allow') {
      pending.resolve({ behavior: 'allow', updatedInput: pending.input })
    } else {
      pending.resolve({ behavior: 'deny', message: 'Denied by the user in the triage web UI.' })
    }
    this.emit({ kind: 'permission_resolved', id, behavior }, true)
  }

  private expirePendingPermissions() {
    for (const [id, pending] of this.pendingPermissions) {
      pending.resolve({ behavior: 'deny', message: 'The session ended before this request was answered.' })
      this.emit({ kind: 'permission_resolved', id, behavior: 'expired' }, true)
    }
    this.pendingPermissions.clear()
  }

  async interrupt() {
    try {
      await this.q.interrupt()
    } catch (err) {
      this.emit({ kind: 'error', message: `interrupt failed: ${String(err)}` }, true)
    }
  }

  private setStatus(status: SessionStatus) {
    if (this.status === status) return
    this.status = status
    broadcastSessionList()
  }

  private emit(event: SessionEvent, persist: boolean) {
    if (persist) {
      this.seq += 1
      store.events.append(this.row.id, this.seq, event).catch((err) => {
        console.error(`[store] failed to persist event for ${this.row.id}:`, err)
      })
    }
    broadcast({ type: 'session_event', sessionId: this.row.id, event })
  }
}

// ---------------------------------------------------------------------------
// Session registry: every session lives in the store; a subset is live.
// ---------------------------------------------------------------------------
const store: Store = openSqliteStore(DB_FILE)
const rows = new Map<string, StoredSession>()
const live = new Map<string, LiveSession>()
const branches = new Map<string, string>() // session id → git branch (derived)

function summarize(row: StoredSession): SessionSummary {
  const l = live.get(row.id)
  return {
    id: row.id,
    title: row.title,
    cwd: row.cwd,
    status: l?.status ?? 'idle',
    model: l?.model,
    branch: branches.get(row.id),
  }
}

/** Sorted like the store: most recently active first. */
function summaries(): SessionSummary[] {
  return [...rows.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(summarize)
}

async function refreshBranch(row: StoredSession) {
  try {
    const { stdout } = await pExecFile('git', ['-C', row.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'])
    const branch = stdout.trim()
    if (branch && branches.get(row.id) !== branch) {
      branches.set(row.id, branch)
      broadcastSessionList()
    }
  } catch {
    // not a git repo — no chip
  }
}

async function createSession(title: string, cwd: string): Promise<StoredSession> {
  const row = await store.sessions.create({ id: randomUUID(), title, cwd })
  rows.set(row.id, row)
  live.set(row.id, new LiveSession(row, 0, null))
  void refreshBranch(row)
  return row
}

/** The live subprocess for a session, starting one (with `resume`) if needed. */
async function getOrRevive(sessionId: string): Promise<LiveSession | null> {
  const existing = live.get(sessionId)
  if (existing) return existing
  const row = rows.get(sessionId)
  if (!row) return null
  const lastSeq = await store.events.lastSeq(row.id)
  const revived = new LiveSession(row, lastSeq, row.sdkSessionId)
  live.set(row.id, revived)
  broadcastSessionList()
  return revived
}

/**
 * Boot: load stored sessions, and expire permission prompts orphaned by the
 * previous process (their subprocess died with it — Allow can never apply).
 */
async function loadSessions() {
  for (const row of await store.sessions.list()) {
    rows.set(row.id, row)
    void refreshBranch(row)

    const events = await store.events.read(row.id)
    const unresolved = new Map<string, true>()
    for (const e of events) {
      if (e.event.kind === 'permission_request') unresolved.set(e.event.id, true)
      if (e.event.kind === 'permission_resolved') unresolved.delete(e.event.id)
    }
    let seq = events.length ? events[events.length - 1].seq : 0
    for (const id of unresolved.keys()) {
      seq += 1
      await store.events.append(row.id, seq, { kind: 'permission_resolved', id, behavior: 'expired' })
    }
  }
}

// ---------------------------------------------------------------------------
// Inbox: ranked work items from deterministic sources (core/work). No cron —
// the server IS the long-running process. Sync happens when the page is
// viewed and the cache is stale (stale-while-revalidate, the cache living in
// SQLite so a fresh server start still renders instantly), on explicit
// Refresh, and on a keep-warm interval while the server runs. A laptop that
// slept through the interval simply syncs on the next view.
// ---------------------------------------------------------------------------
const INBOX_TTL_MS = 5 * 60_000
const INBOX_KEEP_WARM_MS = 15 * 60_000
const SLACK_TTL_MS = 30 * 60_000
const SCHEDULER_TICK_MS = 60_000
const INGESTED_RETENTION_MS = 30 * 86_400_000

const REPOS_KEY = 'github.repos'
const SLACK_CACHE_KEY = 'slack.cache'

type SlackCache = { scannedAt: number; items: WorkItem[] }

let inboxCache: InboxSnapshot | null = null
let inboxInFlight: Promise<InboxSnapshot> | null = null
let slackScanInFlight: Promise<void> | null = null

async function connectedRepos(): Promise<string[]> {
  return (await store.config.get<string[]>(REPOS_KEY)) ?? []
}

/** Is the claude.ai Slack connector connected, per the last connector probe? */
function slackConnected(): boolean | null {
  if (!connectorCache) return null // no probe yet
  return connectorCache.connectors.some(
    (c) => c.source === 'claude.ai' && c.name === 'Slack' && c.status === 'connected',
  )
}

/**
 * Slack items for a sync: the cached scan, always (stale beats blocking — a
 * scan is a whole Claude session). Scanning itself is the scheduler's job;
 * this only reports how stale the cache is.
 */
async function getSlackForSync(): Promise<{ items: WorkItem[]; notice?: string }> {
  const connected = slackConnected()
  if (connected === false) return { items: [] }
  if (connected === null) return { items: [], notice: 'slack: waiting for connector probe — refresh shortly' }

  const cache = await store.config.get<SlackCache>(SLACK_CACHE_KEY)
  if (cache && Date.now() - cache.scannedAt < SLACK_TTL_MS) return { items: cache.items }
  void runDueScans()
  if (cache) {
    const mins = Math.round((Date.now() - cache.scannedAt) / 60_000)
    return { items: cache.items, notice: `slack: showing scan from ${mins}m ago — rescanning in background` }
  }
  return { items: [], notice: 'slack: scanning in background (takes a minute) — refresh shortly' }
}

/**
 * The due-checker (.docs/watches.md): no cron, no fire-time queue. Each tick
 * asks "what is due?" — built-in Slack rules (cache older than its TTL) and
 * enabled watches per their cadence — and runs ONE composed scan for the lot.
 * Missed runs are simply due on the first tick after wake, once; scans are
 * cursor-based, so the coalesced run covers the whole gap losslessly.
 */
async function runDueScans(): Promise<void> {
  if (slackScanInFlight) return slackScanInFlight
  if (slackConnected() !== true) return
  const now = new Date()
  const watches = await store.watches.list()
  const due = watches.filter((w) => isDue(w, now))
  const cache = await store.config.get<SlackCache>(SLACK_CACHE_KEY)
  const builtins = !cache || Date.now() - cache.scannedAt >= SLACK_TTL_MS
  if (!builtins && due.length === 0) return

  slackScanInFlight = (async () => {
    try {
      const specs: WatchScanSpec[] = due.map((w) => ({
        id: w.id,
        scope: w.scope,
        instruction: w.instruction,
        cursor: w.cursor,
        createsItems: w.createsItems,
      }))
      const outcome = await runSlackScan({ builtins, watches: specs })
      if (builtins) {
        await store.config.set(SLACK_CACHE_KEY, {
          scannedAt: Date.now(),
          items: outcome.builtinItems,
        } satisfies SlackCache)
      }
      // Idempotent upsert: id-keyed, update-only-if-newer, state-preserving.
      for (const item of outcome.watchItems) await store.items.upsert(item)
      for (const w of due) {
        await store.watches.recordRun(w.id, {
          cursor: outcome.startedAt, // the scan covered everything before it started
          lastRunAt: Date.now(),
          lastRunTokens: outcome.tokens,
          lastRunMatches: outcome.matchesByWatch.get(w.id) ?? 0,
        })
      }
      await store.items.prune(Date.now() - INGESTED_RETENTION_MS)
      inboxCache = null // next view rebuilds the snapshot with the fresh scan
      await syncInbox()
    } catch (err) {
      console.error('[slack] scan failed:', err)
    } finally {
      slackScanInFlight = null
    }
  })()
  return slackScanInFlight
}

setInterval(() => {
  runDueScans().catch((err) => console.error('[watches] tick failed:', err))
}, SCHEDULER_TICK_MS).unref()

function syncInbox(): Promise<InboxSnapshot> {
  if (inboxInFlight) return inboxInFlight
  inboxInFlight = (async () => {
    try {
      const [repos, slack, ingested, states] = await Promise.all([
        connectedRepos(),
        getSlackForSync(),
        store.items.list(),
        store.itemState.all(),
      ])
      const { items, notices, rearmed } = await refreshInbox({ repos, slack, ingested, states })
      if (rearmed.length > 0) await store.itemState.reopen(rearmed, Date.now())
      inboxCache = { syncedAt: Date.now(), items, notices }
      void store.inbox.save(inboxCache)
      return inboxCache
    } finally {
      inboxInFlight = null
    }
  })()
  return inboxInFlight
}

// The repo picker's "available" list; slow-ish (paginated), so cached.
let affiliatedCache: { at: number; repos: string[] } | null = null
async function affiliatedRepos(): Promise<string[]> {
  if (affiliatedCache && Date.now() - affiliatedCache.at < 10 * 60_000) return affiliatedCache.repos
  const repos = await listAffiliatedRepos()
  affiliatedCache = { at: Date.now(), repos }
  return repos
}

async function getInbox(force: boolean): Promise<InboxSnapshot> {
  if (!force && inboxCache && Date.now() - inboxCache.syncedAt < INBOX_TTL_MS) return inboxCache
  return syncInbox()
}

// Keep the cache warm while the server runs, so page loads are instant. A
// failed background sync keeps the previous snapshot; the next view retries.
setInterval(() => {
  syncInbox().catch((err) => console.error('[inbox] background sync failed:', err))
}, INBOX_KEEP_WARM_MS).unref()

// ---------------------------------------------------------------------------
// Connectors: what a session will actually load, learned the honest way — by
// spawning a throwaway query with the SAME options real sessions use and
// asking it via the mcpServerStatus() control request (no user message, no
// API turn). `claude mcp list` has no machine output, and the config files
// under ~/.claude are private formats; this is the SDK's own structured
// answer to "which servers connected".
// ---------------------------------------------------------------------------
type ConnectorProbe = { probedAt: number; connectors: Connector[] }

let connectorCache: ConnectorProbe | null = null
let connectorInFlight: Promise<ConnectorProbe> | null = null

const CLAUDE_AI_PREFIX = 'claude.ai '

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))

function probeConnectors(): Promise<ConnectorProbe> {
  // Concurrent requests share one probe — a probe is a whole subprocess.
  if (connectorInFlight) return connectorInFlight
  connectorInFlight = (async () => {
    const input = new AsyncQueue<SDKUserMessage>()
    const q = query({
      prompt: input,
      options: {
        cwd: os.homedir(), // user-level view; no project .mcp.json in the way
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
      },
    })
    try {
      // Servers connect asynchronously; poll until none are pending (or the
      // budget runs out and we report the stragglers as they are).
      const deadline = Date.now() + 45_000
      let statuses = await q.mcpServerStatus()
      while (statuses.some((srv) => srv.status === 'pending') && Date.now() < deadline) {
        await sleep(1_000)
        statuses = await q.mcpServerStatus()
      }
      const connectors = statuses
        .map((srv): Connector =>
          srv.name.startsWith(CLAUDE_AI_PREFIX)
            ? { name: srv.name.slice(CLAUDE_AI_PREFIX.length), status: srv.status, source: 'claude.ai' }
            : { name: srv.name, status: srv.status, source: 'local' },
        )
        .sort((a, b) => a.name.localeCompare(b.name))
      connectorCache = { probedAt: Date.now(), connectors }
      return connectorCache
    } finally {
      input.close()
      void q.return(undefined).catch(() => {}) // dispose the subprocess
      connectorInFlight = null
    }
  })()
  return connectorInFlight
}

// ---------------------------------------------------------------------------
// HTTP: JSON API + the built SPA
// ---------------------------------------------------------------------------
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1_000_000) reject(new Error('body too large'))
    })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : null)
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// Input validation — the HTTP surface is untrusted (vision principle 6):
// bodies are validated into domain shapes, and rejected rather than repaired.
// ---------------------------------------------------------------------------

const CADENCES = new Set<WatchCadence>(['hourly', 'daily', 'weekly'])
const ITEM_STATUSES = new Set<ItemStatus>(['open', 'done', 'snoozed', 'dismissed'])
const VALID_KINDS = new Set(Object.keys(BASE))
const VALID_SOURCES = new Set(['github', 'slack', 'linear'])
const ITEM_ID_RE = /^(github|slack|linear):\S+$/

type WatchPatch = Partial<NewWatch> & { enabled?: boolean }

function watchPatchFrom(raw: unknown): { patch: WatchPatch } | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'body must be a JSON object' }
  const r = raw as Record<string, unknown>
  const patch: WatchPatch = {}
  if (r.title !== undefined) {
    if (typeof r.title !== 'string' || !r.title.trim()) return { error: 'title must be a non-empty string' }
    patch.title = r.title.trim()
  }
  if (r.scope !== undefined) {
    if (typeof r.scope !== 'string' || !/^[#@]\S+$/.test(r.scope.trim())) return { error: 'scope must be "#channel" or "@dm"' }
    patch.scope = r.scope.trim()
  }
  if (r.instruction !== undefined) {
    if (typeof r.instruction !== 'string' || !r.instruction.trim()) return { error: 'instruction must be a non-empty string' }
    patch.instruction = r.instruction.trim()
  }
  if (r.cadence !== undefined) {
    if (!CADENCES.has(r.cadence as WatchCadence)) return { error: 'cadence must be hourly | daily | weekly' }
    patch.cadence = r.cadence as WatchCadence
  }
  if (r.windowStart !== undefined && r.windowStart !== null) {
    if (typeof r.windowStart !== 'string' || !/^\d{1,2}:\d{2}$/.test(r.windowStart)) return { error: 'windowStart must be "HH:MM"' }
    patch.windowStart = r.windowStart
  }
  if (r.windowDay !== undefined && r.windowDay !== null) {
    if (typeof r.windowDay !== 'number' || !Number.isInteger(r.windowDay) || r.windowDay < 0 || r.windowDay > 6) return { error: 'windowDay must be 0-6' }
    patch.windowDay = r.windowDay
  }
  if (r.createsItems !== undefined) {
    if (typeof r.createsItems !== 'boolean') return { error: 'createsItems must be a boolean' }
    patch.createsItems = r.createsItems
  }
  if (r.enabled !== undefined) {
    if (typeof r.enabled !== 'boolean') return { error: 'enabled must be a boolean' }
    patch.enabled = r.enabled
  }
  return { patch }
}

/** A full ingested WorkItem, validated field by field. Rejects, never repairs. */
function workItemFrom(raw: unknown): { item: WorkItem } | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'body must be a JSON object' }
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !ITEM_ID_RE.test(r.id)) return { error: 'id must look like "slack:...", "github:owner/repo#123", or "linear:KEY-123"' }
  const source = r.id.slice(0, r.id.indexOf(':'))
  if (r.source !== undefined && r.source !== source) return { error: `source must match the id prefix ("${source}")` }
  if (!VALID_SOURCES.has(source)) return { error: 'unknown source' }
  if (typeof r.kind !== 'string' || !VALID_KINDS.has(r.kind)) return { error: `kind must be one of: ${[...VALID_KINDS].join(', ')}` }
  if (typeof r.title !== 'string' || !r.title.trim()) return { error: 'title must be a non-empty string' }
  if (typeof r.url !== 'string' || !r.url.startsWith('http')) return { error: 'url must be an http(s) URL' }
  if (typeof r.updatedAt !== 'string' || !Number.isFinite(Date.parse(r.updatedAt))) return { error: 'updatedAt must be an ISO 8601 timestamp' }
  const createdAt = typeof r.createdAt === 'string' && Number.isFinite(Date.parse(r.createdAt)) ? r.createdAt : r.updatedAt
  return {
    item: {
      id: r.id,
      source: source as WorkItem['source'],
      kind: r.kind as WorkItem['kind'],
      title: r.title.trim(),
      url: r.url,
      repo: typeof r.repo === 'string' ? r.repo : '',
      author: typeof r.author === 'string' ? r.author : '',
      peopleWaiting: typeof r.peopleWaiting === 'number' && r.peopleWaiting >= 0 ? Math.floor(r.peopleWaiting) : 0,
      createdAt,
      updatedAt: r.updatedAt,
      ...(typeof r.watchId === 'string' ? { watchId: r.watchId } : {}),
      ...(typeof r.why === 'string' && r.why ? { why: r.why } : {}),
      ...(canonicalizeRefs(r.refs) ? { refs: canonicalizeRefs(r.refs) } : {}),
    },
  }
}

const NO_BUILD_HTML = `<!doctype html><meta charset="utf-8">
<title>triage — no build</title>
<body style="font:14px/1.6 system-ui;max-width:34em;margin:12vh auto;color:#dce3f0;background:#0d1017">
<h2 style="color:#e8b04b">No web build found</h2>
<p>This server is serving the production bundle from <code>dist/web</code>, which does not exist yet.</p>
<p>For development, run <code>npm run dev</code> and open the Vite URL it prints — it proxies
<code>/ws</code> and <code>/api</code> back here.</p>
<p>For a production-style run: <code>npm run build &amp;&amp; npm start</code>.</p>
</body>`

async function serveWeb(pathname: string, res: http.ServerResponse) {
  // Any path that is not a real asset falls back to index.html (SPA routing).
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const resolved = path.resolve(WEB_DIR, rel)
  const candidate = resolved.startsWith(WEB_DIR + path.sep) ? resolved : path.join(WEB_DIR, 'index.html')

  for (const file of [candidate, path.join(WEB_DIR, 'index.html')]) {
    try {
      const body = await readFile(file)
      res.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream' })
      res.end(body)
      return
    } catch {
      // try the SPA fallback next
    }
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(NO_BUILD_HTML)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  if (url.pathname === '/api/sessions') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(summaries()))
    return
  }
  if (url.pathname === '/api/inbox') {
    let body: InboxResponse
    try {
      const snap = await getInbox(url.searchParams.get('refresh') === '1')
      body = { ok: true, ...snap }
    } catch (err) {
      body = { ok: false, error: String(err) }
    }
    res.writeHead(body.ok ? 200 : 502, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
    return
  }
  if (url.pathname === '/api/repos') {
    let body: ReposResponse
    try {
      if (req.method === 'PUT') {
        const parsed = (await readJsonBody(req)) as { repos?: unknown } | null
        const repos = Array.isArray(parsed?.repos)
          ? parsed.repos.filter((r): r is string => typeof r === 'string' && /^[\w.-]+\/[\w.-]+$/.test(r))
          : []
        await store.config.set(REPOS_KEY, repos)
        inboxCache = null // scope changed — force a resync on the next view
      }
      body = { ok: true, connected: await connectedRepos(), available: await affiliatedRepos() }
    } catch (err) {
      body = { ok: false, error: String(err) }
    }
    res.writeHead(body.ok ? 200 : 502, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
    return
  }
  if (url.pathname === '/api/projects') {
    let body: ProjectsResponse
    let status = 200
    try {
      if (req.method === 'POST') {
        const parsed = (await readJsonBody(req)) as Partial<Project> | null
        const name = typeof parsed?.name === 'string' ? parsed.name.trim() : ''
        const repo = typeof parsed?.repo === 'string' ? parsed.repo.trim() : ''
        const rawPath = typeof parsed?.path === 'string' ? parsed.path.trim() : ''
        if (!name || !rawPath) throw new Error('a project needs a name and a folder')
        if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`"${repo}" is not owner/name`)
        const resolved = expandHome(rawPath)
        const st = await stat(resolved).catch(() => null)
        if (!st?.isDirectory()) throw new Error(`folder not found: ${resolved}`)
        await store.projects.create({ id: randomUUID(), name, repo, path: resolved })
      } else if (req.method === 'DELETE') {
        const id = url.searchParams.get('id')
        if (id) await store.projects.remove(id)
      }
      body = { ok: true, projects: await store.projects.list() }
    } catch (err) {
      status = 400
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    res.writeHead(body.ok ? 200 : status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
    return
  }
  if (url.pathname === '/api/watches') {
    let body: WatchesResponse
    let status = 200
    try {
      if (req.method === 'POST') {
        const parsed = watchPatchFrom(await readJsonBody(req))
        if ('error' in parsed) throw new Error(parsed.error)
        const p = parsed.patch
        if (!p.title || !p.scope || !p.instruction || !p.cadence) {
          throw new Error('a watch needs title, scope, instruction, and cadence')
        }
        const now = Date.now()
        await store.watches.create({
          id: randomUUID(),
          source: 'slack',
          title: p.title,
          scope: p.scope,
          instruction: p.instruction,
          cadence: p.cadence,
          windowStart: p.windowStart,
          windowDay: p.windowDay,
          enabled: p.enabled ?? true,
          createsItems: p.createsItems ?? true,
          createdAt: now,
          updatedAt: now,
        })
        // active on the next scheduler tick (never run → due immediately)
      } else if (req.method === 'PUT') {
        const id = url.searchParams.get('id')
        if (!id || !(await store.watches.get(id))) throw new Error('unknown watch id')
        const parsed = watchPatchFrom(await readJsonBody(req))
        if ('error' in parsed) throw new Error(parsed.error)
        await store.watches.update(id, parsed.patch)
      } else if (req.method === 'DELETE') {
        const id = url.searchParams.get('id')
        if (id) {
          await store.watches.remove(id)
          await store.items.removeByWatch(id)
          inboxCache = null
        }
      }
      body = { ok: true, watches: await store.watches.list() }
    } catch (err) {
      status = 400
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    res.writeHead(body.ok ? 200 : status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
    return
  }
  if (url.pathname === '/api/watches/draft' && req.method === 'POST') {
    let body: WatchDraftResponse
    try {
      const parsed = (await readJsonBody(req)) as { text?: unknown } | null
      const text = typeof parsed?.text === 'string' ? parsed.text.trim() : ''
      if (!text) throw new Error('describe the watch in plain text first')
      const draft = await draftWatch(text)
      if (!draft) throw new Error('could not parse that into a watch — fill the form manually')
      body = { ok: true, draft }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    res.writeHead(body.ok ? 200 : 502, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
    return
  }
  if (url.pathname === '/api/watches/preview' && req.method === 'POST') {
    let body: WatchPreviewResponse
    try {
      const parsed = watchPatchFrom(await readJsonBody(req))
      if ('error' in parsed) throw new Error(parsed.error)
      const { scope, instruction } = parsed.patch
      if (!scope || !instruction) throw new Error('a preview needs scope and instruction')
      if (slackConnected() === false) throw new Error('the claude.ai Slack connector is not connected')
      const { rows, tokens } = await previewWatch(scope, instruction)
      body = { ok: true, rows, tokens }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    res.writeHead(body.ok ? 200 : 502, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
    return
  }
  if (url.pathname === '/api/items/state' && req.method === 'POST') {
    let body: ItemStateResponse
    try {
      const parsed = (await readJsonBody(req)) as { id?: unknown; status?: unknown; snoozeUntil?: unknown } | null
      const id = typeof parsed?.id === 'string' ? parsed.id : ''
      const statusV = parsed?.status as ItemStatus
      if (!id || !ITEM_STATUSES.has(statusV)) throw new Error('need an item id and a status (open|done|snoozed|dismissed)')
      const snoozeUntil = typeof parsed?.snoozeUntil === 'number' ? parsed.snoozeUntil : undefined
      if (statusV === 'snoozed' && !snoozeUntil) throw new Error('snoozed needs snoozeUntil (epoch ms)')
      await store.itemState.set({ itemId: id, status: statusV, statusAt: Date.now(), snoozeUntil, pinned: false })
      inboxCache = null // the overlay changed — next view recomputes
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    res.writeHead(body.ok ? 200 : 400, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
    return
  }
  // The ingestion contract (.docs/watches.md): idempotent upsert + resolve,
  // shared by external scanners over HTTP and the MCP shim (server/mcp.ts).
  // User state is never written by upsert; resolve is a normal 'done'.
  if (url.pathname === '/api/items/upsert' && req.method === 'POST') {
    let body: UpsertResponse
    try {
      const parsed = workItemFrom(await readJsonBody(req))
      if ('error' in parsed) throw new Error(parsed.error)
      const outcome = await store.items.upsert(parsed.item)
      if (outcome !== 'unchanged') inboxCache = null
      body = { ok: true, outcome }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    res.writeHead(body.ok ? 200 : 400, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
    return
  }
  if (url.pathname === '/api/items/resolve' && req.method === 'POST') {
    let body: ItemStateResponse
    try {
      const parsed = (await readJsonBody(req)) as { id?: unknown } | null
      const id = typeof parsed?.id === 'string' ? parsed.id : ''
      if (!ITEM_ID_RE.test(id)) throw new Error('need a work-item id')
      await store.itemState.set({ itemId: id, status: 'done', statusAt: Date.now(), pinned: false })
      inboxCache = null
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    res.writeHead(body.ok ? 200 : 400, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
    return
  }
  if (url.pathname === '/api/connectors') {
    let body: ConnectorsResponse
    try {
      const probe =
        connectorCache && url.searchParams.get('refresh') !== '1'
          ? connectorCache
          : await probeConnectors()
      body = { ok: true, probedAt: probe.probedAt, connectors: probe.connectors }
    } catch (err) {
      body = { ok: false, error: String(err) }
    }
    res.writeHead(body.ok ? 200 : 502, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
    return
  }
  await serveWeb(url.pathname, res)
})

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/ws' })
const clients = new Set<WebSocket>()

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function broadcast(msg: ServerMessage) {
  const data = JSON.stringify(msg)
  for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(data)
}

function broadcastSessionList() {
  broadcast({ type: 'sessions', sessions: summaries() })
}

function expandHome(p: string): string {
  if (!p) return process.cwd()
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return path.resolve(p)
}

/**
 * The socket is untrusted input (vision principle 6), so incoming frames are
 * validated into the ClientMessage union rather than cast into it.
 */
function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  switch (m.type) {
    case 'create_session':
      return {
        type: 'create_session',
        title: str(m.title),
        cwd: str(m.cwd),
        firstMessage: typeof m.firstMessage === 'string' ? m.firstMessage : undefined,
      }
    case 'subscribe':
      return typeof m.sessionId === 'string' ? { type: 'subscribe', sessionId: m.sessionId } : null
    case 'user_message':
      return typeof m.sessionId === 'string'
        ? { type: 'user_message', sessionId: m.sessionId, text: str(m.text) }
        : null
    case 'permission_response':
      return typeof m.sessionId === 'string' && typeof m.requestId === 'string'
        ? {
            type: 'permission_response',
            sessionId: m.sessionId,
            requestId: m.requestId,
            behavior: m.behavior === 'allow' ? 'allow' : 'deny',
          }
        : null
    case 'interrupt':
      return typeof m.sessionId === 'string' ? { type: 'interrupt', sessionId: m.sessionId } : null
    default:
      return null
  }
}

wss.on('connection', (ws) => {
  clients.add(ws)
  send(ws, { type: 'hello', sessions: summaries() })

  ws.on('message', async (raw) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(String(raw))
    } catch {
      return
    }
    const msg = parseClientMessage(parsed)
    if (!msg) return

    try {
      switch (msg.type) {
        case 'create_session': {
          const cwd = expandHome(msg.cwd)
          const title = msg.title.trim() || `Session ${rows.size + 1}`
          const row = await createSession(title, cwd)
          send(ws, { type: 'session_created', session: summarize(row) })
          broadcastSessionList()
          if (msg.firstMessage?.trim()) live.get(row.id)?.sendUserMessage(msg.firstMessage.trim())
          break
        }
        case 'subscribe': {
          if (!rows.has(msg.sessionId)) break
          const events = await store.events.read(msg.sessionId)
          send(ws, { type: 'history', sessionId: msg.sessionId, events: events.map((e) => e.event) })
          break
        }
        case 'user_message': {
          if (!msg.text.trim()) break
          const session = await getOrRevive(msg.sessionId)
          session?.sendUserMessage(msg.text.trim())
          break
        }
        case 'permission_response': {
          live.get(msg.sessionId)?.resolvePermission(msg.requestId, msg.behavior)
          break
        }
        case 'interrupt': {
          void live.get(msg.sessionId)?.interrupt()
          break
        }
      }
    } catch (err) {
      send(ws, { type: 'error', message: String(err) })
    }
  })

  ws.on('close', () => clients.delete(ws))
})

await loadSessions()
inboxCache = await store.inbox.load() // last snapshot, so first paint is instant
// Probe connectors in the background at startup: the Slack source gates on the
// result, and the Connectors page becomes instant.
probeConnectors().catch((err) => console.error('[connectors] startup probe failed:', err))
server.listen(PORT, () => {
  console.log(`triage-dev server → http://localhost:${PORT}  (db: ${DB_FILE})`)
})
