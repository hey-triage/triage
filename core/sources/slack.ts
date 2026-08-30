/**
 * Slack scanning — built-in rules + user-defined watches (.docs/watches.md),
 * re-based onto the Agent SDK. Fetched *through* the installed Claude Code's
 * claude.ai Slack connector, headless and read-only by construction (tool
 * allowlist) — this repo never holds Slack credentials.
 *
 * Design rules: the LLM reads and extracts (URLs, refs, timestamps) and
 * answers exactly one judgment per candidate — "does this match — yes/no
 * (+ a one-line why)". It never scores, never merges, never decides done.
 * Malformed output rows are discarded, never repaired.
 *
 * One composed scan per due batch, not one session per watch: the fixed
 * built-in sections plus one section per due watch, in a single subprocess.
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
import { canonicalizeRefs } from '../work/link.js'
import type { WorkItem } from '../work/types.js'
import type { WatchDraft, WatchPreviewRow } from '../watch/types.js'

const READ_ONLY_SLACK_TOOLS = [
  'ToolSearch',
  'mcp__claude_ai_Slack__slack_search_public_and_private',
  'mcp__claude_ai_Slack__slack_read_thread',
  'mcp__claude_ai_Slack__slack_read_channel',
  'mcp__claude_ai_Slack__slack_read_user_profile',
]

/** rows a single watch may emit per scan (cost control; also enforced here) */
export const MAX_ROWS_PER_WATCH = 15

export interface WatchScanSpec {
  id: string
  /** '#channel' | '@dm' — the boundary the section may not leave */
  scope: string
  instruction: string
  /** ISO watermark: scan messages after this; absent = recent-history window */
  cursor?: string
  createsItems: boolean
}

// ---------------------------------------------------------------------------
// Prompt composition
// ---------------------------------------------------------------------------

const SCAN_PREAMBLE = `You are a triage scanner. Your Slack tools are deferred: first use ToolSearch to load mcp__claude_ai_Slack__slack_search_public_and_private, mcp__claude_ai_Slack__slack_read_channel and mcp__claude_ai_Slack__slack_read_thread, then use them (read-only) to perform every scan section below.

Judge each candidate on its title and first ~200 characters; only read a full thread when that snippet is not enough to decide. Stay strictly inside each section's stated scope and time window.`

const BUILTIN_SECTION = `SECTION builtins — across the workspace, from the last 3 days:
1. Messages that mention/tag the user (the authenticated Slack account).
2. Threads the user participated in where the LATEST message is a question or request directed at the user that they have not answered yet (a reply is pending from them).
Rules: deduplicate threads (one row per thread, prefer kind reply-pending); if the user already answered, exclude it. Rows from this section carry "kind": "mention" or "reply-pending" (no watchId).`

function watchSection(w: WatchScanSpec): string {
  const window = w.cursor
    ? `messages newer than ${w.cursor}`
    : `messages from the last 7 days`
  return `SECTION watch ${w.id} — in ${w.scope} ONLY, scan ${window}. Match threads where: ${w.instruction}
Rules: one row per thread; at most ${MAX_ROWS_PER_WATCH} rows; skip anything outside ${w.scope}. Rows from this section carry "watchId": "${w.id}" (no kind), a one-line "why" stating what matched, and "refs": an array of any GitHub PR/issue URLs or Linear issue keys visible in the matched content (empty array if none).`
}

const OUTPUT_CONTRACT = `Output ONLY one JSON array combining all sections' rows — no prose, no code fence. Each row:
{"title": "<one-line summary>", "permalink": "<slack message permalink>", "channel": "#<channel name>", "from": "<display name of the author/asker>", "lastActivity": "<ISO 8601 timestamp of the newest message in the thread>", "kind": "mention" | "reply-pending" (builtins only), "watchId": "<id>" (watch sections only), "why": "<one line>" (watch sections only), "refs": ["..."] (watch sections only)}
If nothing qualifies anywhere, output [].
If you cannot access any Slack tools at all, output exactly: {"error": "no-slack-tools"}`

export function composeScanPrompt(builtins: boolean, watches: WatchScanSpec[]): string {
  return [
    SCAN_PREAMBLE,
    ...(builtins ? [BUILTIN_SECTION] : []),
    ...watches.map(watchSection),
    OUTPUT_CONTRACT,
  ].join('\n\n')
}

// ---------------------------------------------------------------------------
// Output parsing — strict, per-row validation; malformed rows are discarded.
// ---------------------------------------------------------------------------

export interface RawBuiltinRow {
  title: string
  permalink: string
  channel: string
  from: string
  lastActivity: string
  kind: 'mention' | 'reply-pending'
}

export interface RawWatchRow {
  title: string
  permalink: string
  channel: string
  from: string
  lastActivity: string
  watchId: string
  why: string
  refs?: string[]
}

function validBase(r: Record<string, unknown>): boolean {
  return (
    typeof r.title === 'string' && r.title.length > 0 &&
    typeof r.permalink === 'string' && r.permalink.startsWith('http') &&
    typeof r.channel === 'string' &&
    typeof r.from === 'string'
  )
}

/** Extract and validate the JSON array from agent output. Pure. */
export function parseScanRows(
  raw: string,
  knownWatchIds: Set<string>,
): { builtins: RawBuiltinRow[]; watches: RawWatchRow[] } {
  const builtins: RawBuiltinRow[] = []
  const watches: RawWatchRow[] = []
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start === -1 || end <= start) return { builtins, watches }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return { builtins, watches }
  }
  if (!Array.isArray(parsed)) return { builtins, watches }
  const perWatch = new Map<string, number>()
  for (const row of parsed) {
    if (typeof row !== 'object' || row === null) continue
    const r = row as Record<string, unknown>
    if (!validBase(r)) continue
    if (r.kind === 'mention' || r.kind === 'reply-pending') {
      builtins.push(r as unknown as RawBuiltinRow)
    } else if (typeof r.watchId === 'string' && knownWatchIds.has(r.watchId) && typeof r.why === 'string' && r.why.length > 0) {
      const n = perWatch.get(r.watchId) ?? 0
      if (n >= MAX_ROWS_PER_WATCH) continue
      perWatch.set(r.watchId, n + 1)
      watches.push(r as unknown as RawWatchRow)
    }
  }
  return { builtins, watches }
}

// ---------------------------------------------------------------------------
// Normalization — identity is deterministic: one item per thread, keyed by
// the permalink tail. Same scheme for every scanner, external ones included.
// ---------------------------------------------------------------------------

function permalinkId(permalink: string): string {
  const tail = permalink.replace(/^https?:\/\/[^/]+\/archives\//, '').replace(/[?#].*$/, '')
  return `slack:${tail}`
}

function safeWhen(iso: string, now: number): string {
  return Number.isFinite(Date.parse(iso)) ? iso : new Date(now).toISOString()
}

export function normalizeBuiltinRows(rows: RawBuiltinRow[], now = Date.now()): WorkItem[] {
  return rows.map((row) => {
    const when = safeWhen(row.lastActivity, now)
    return {
      id: permalinkId(row.permalink),
      source: 'slack' as const,
      kind: row.kind === 'reply-pending' ? ('slack-reply-pending' as const) : ('slack-mention' as const),
      title: row.title,
      url: row.permalink,
      repo: row.channel,
      author: row.from,
      peopleWaiting: row.kind === 'reply-pending' ? 1 : 0,
      createdAt: when,
      updatedAt: when,
    }
  })
}

export function normalizeWatchRows(
  rows: RawWatchRow[],
  specs: Map<string, WatchScanSpec>,
  now = Date.now(),
): WorkItem[] {
  return rows.flatMap((row) => {
    const spec = specs.get(row.watchId)
    if (!spec) return []
    const when = safeWhen(row.lastActivity, now)
    return [{
      id: permalinkId(row.permalink),
      source: 'slack' as const,
      kind: spec.createsItems ? ('watch-hit' as const) : ('fyi' as const),
      title: row.title,
      url: row.permalink,
      repo: row.channel,
      author: row.from,
      peopleWaiting: 0,
      createdAt: when,
      updatedAt: when,
      watchId: row.watchId,
      why: row.why,
      refs: canonicalizeRefs(row.refs),
    }]
  })
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface SlackScanOutcome {
  builtinItems: WorkItem[]
  watchItems: WorkItem[]
  matchesByWatch: Map<string, number>
  /** total tokens the scan consumed (0 when the SDK reports none) */
  tokens: number
  /** ISO time the scan started — the next cursor for every watch it covered */
  startedAt: string
}

/** Run one headless prompt to completion; returns the result text + tokens. */
async function runHeadless(prompt: string, timeoutMs: number): Promise<{ text: string; tokens: number }> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  try {
    const q = query({
      prompt,
      options: {
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user'],
        allowedTools: READ_ONLY_SLACK_TOOLS,
        abortController: abort,
      },
    })
    let text = ''
    let tokens = 0
    for await (const msg of q) {
      const m = msg as { type: string; result?: string; usage?: Record<string, unknown> }
      if (m.type === 'result') {
        text = typeof m.result === 'string' ? m.result : ''
        const u = m.usage ?? {}
        for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
          const v = u[k]
          if (typeof v === 'number') tokens += v
        }
        break
      }
    }
    if (text.includes('"no-slack-tools"')) {
      throw new Error('no Slack tools — enable Slack for Claude at claude.ai/settings/connectors')
    }
    return { text, tokens }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One composed scan: built-in rules (when due) + every due watch, in a single
 * session. Throws on timeout or a missing connector; the caller decides how
 * that degrades (notice + retry on the next tick).
 */
export async function runSlackScan(
  opts: { builtins: boolean; watches: WatchScanSpec[]; timeoutMs?: number },
  now = Date.now(),
): Promise<SlackScanOutcome> {
  const startedAt = new Date(now).toISOString()
  const { text, tokens } = await runHeadless(
    composeScanPrompt(opts.builtins, opts.watches),
    opts.timeoutMs ?? 240_000,
  )
  const specs = new Map(opts.watches.map((w) => [w.id, w]))
  const rows = parseScanRows(text, new Set(specs.keys()))
  const matchesByWatch = new Map<string, number>(opts.watches.map((w) => [w.id, 0]))
  for (const row of rows.watches) {
    matchesByWatch.set(row.watchId, (matchesByWatch.get(row.watchId) ?? 0) + 1)
  }
  return {
    builtinItems: normalizeBuiltinRows(rows.builtins, now),
    watchItems: normalizeWatchRows(rows.watches, specs, now),
    matchesByWatch,
    tokens,
    startedAt,
  }
}

/** Backwards-compatible built-ins-only scan. */
export async function scanSlack(timeoutMs = 180_000): Promise<WorkItem[]> {
  const outcome = await runSlackScan({ builtins: true, watches: [], timeoutMs })
  return outcome.builtinItems
}

// ---------------------------------------------------------------------------
// Watch preview — the trust-maker in the creation flow: run a draft against
// the scope's recent history and show what it *would have* matched. Reads
// only; never touches watches, cursors, or items.
// ---------------------------------------------------------------------------

export async function previewWatch(
  scope: string,
  instruction: string,
  timeoutMs = 240_000,
): Promise<{ rows: WatchPreviewRow[]; tokens: number }> {
  const spec: WatchScanSpec = { id: 'preview', scope, instruction, createsItems: true }
  const { text, tokens } = await runHeadless(composeScanPrompt(false, [spec]), timeoutMs)
  const rows = parseScanRows(text, new Set(['preview'])).watches.map((r) => ({
    title: r.title,
    permalink: r.permalink,
    channel: r.channel,
    from: r.from,
    lastActivity: r.lastActivity,
    why: r.why,
  }))
  return { rows, tokens }
}

// ---------------------------------------------------------------------------
// Watch drafting — one LLM call parsing a plain-text wish into the structured
// form. Every field stays editable in the UI; this is a convenience, not an
// authority, so a parse failure just returns null and the user fills the form.
// ---------------------------------------------------------------------------

const DRAFT_PROMPT = (text: string) => `Parse this watch request into JSON. A watch scans one Slack scope (a "#channel" or "@dm") on a cadence for threads matching a plain-English instruction.

Request: ${JSON.stringify(text)}

Output ONLY a JSON object, no prose, no code fence:
{"title": "<short name, e.g. 'PX topics in #novus-px'>", "scope": "<#channel or @dm mentioned>", "instruction": "<the matching criteria as one clear sentence, including any exclusions>", "cadence": "hourly" | "daily" | "weekly" (default "daily" unless the request implies otherwise), "createsItems": true unless the request says FYI/digest-only}`

export async function draftWatch(text: string, timeoutMs = 60_000): Promise<WatchDraft | null> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  try {
    const q = query({
      prompt: DRAFT_PROMPT(text),
      options: {
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: [],
        allowedTools: [],
        abortController: abort,
      },
    })
    let out = ''
    for await (const msg of q) {
      const m = msg as { type: string; result?: string }
      if (m.type === 'result') {
        out = typeof m.result === 'string' ? m.result : ''
        break
      }
    }
    const start = out.indexOf('{')
    const end = out.lastIndexOf('}')
    if (start === -1 || end <= start) return null
    const parsed = JSON.parse(out.slice(start, end + 1)) as Record<string, unknown>
    if (typeof parsed.title !== 'string' || typeof parsed.scope !== 'string' || typeof parsed.instruction !== 'string') return null
    const cadence = parsed.cadence === 'hourly' || parsed.cadence === 'weekly' ? parsed.cadence : 'daily'
    return {
      title: parsed.title,
      scope: parsed.scope,
      instruction: parsed.instruction,
      cadence,
      createsItems: parsed.createsItems !== false,
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
