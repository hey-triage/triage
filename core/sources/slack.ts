/**
 * Slack source — ported from hey-triage (src/sources/slack.ts, decision 010),
 * re-based onto the Agent SDK. Fetched *through* the installed Claude Code's
 * claude.ai Slack connector, headless and read-only — this repo never holds
 * Slack credentials. Extraction is agent-mediated and best-effort; the
 * normalized items are scored deterministically like any other source.
 *
 * This is the connector-backed source tier: it costs tokens and tens of
 * seconds, so callers cache the result with a TTL and scan in the background —
 * it must never sit in the inbox view's critical path.
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { WorkItem } from '../work/types.js'

const READ_ONLY_SLACK_TOOLS = [
  'ToolSearch',
  'mcp__claude_ai_Slack__slack_search_public_and_private',
  'mcp__claude_ai_Slack__slack_read_thread',
  'mcp__claude_ai_Slack__slack_read_channel',
  'mcp__claude_ai_Slack__slack_read_user_profile',
]

const SCAN_PROMPT = `You are a triage scanner. Your Slack tools are deferred: first use ToolSearch to load mcp__claude_ai_Slack__slack_search_public_and_private and mcp__claude_ai_Slack__slack_read_thread, then use them (read-only) to find, from the last 3 days:
1. Messages that mention/tag the user (the authenticated Slack account).
2. Threads the user participated in where the LATEST message is a question or request directed at the user that they have not answered yet (a reply is pending from them).

Output ONLY a JSON array, no prose, no code fence. Each element:
{"title": "<one-line summary of what is being asked>", "permalink": "<slack message permalink>", "channel": "#<channel name>", "from": "<display name of who is waiting/tagging>", "lastActivity": "<ISO 8601 timestamp>", "kind": "mention" | "reply-pending"}

Rules: at most 15 elements; deduplicate threads (one element per thread, prefer kind reply-pending); if the user already answered, exclude it; if nothing qualifies, output [].
If you cannot access any Slack tools at all, output exactly: {"error": "no-slack-tools"}`

interface RawSlackRow {
  title: string
  permalink: string
  channel: string
  from: string
  lastActivity: string
  kind: 'mention' | 'reply-pending'
}

/** Extract and validate the JSON array from agent output. Pure. */
export function parseAgentItems(raw: string): RawSlackRow[] {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start === -1 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter((row): row is RawSlackRow => {
    if (typeof row !== 'object' || row === null) return false
    const r = row as Record<string, unknown>
    return (
      typeof r.title === 'string' && r.title.length > 0 &&
      typeof r.permalink === 'string' && r.permalink.startsWith('http') &&
      typeof r.channel === 'string' &&
      typeof r.from === 'string' &&
      (r.kind === 'mention' || r.kind === 'reply-pending')
    )
  })
}

export function normalizeSlackRows(rows: RawSlackRow[], now = Date.now()): WorkItem[] {
  return rows.map((row) => {
    const when = Number.isFinite(Date.parse(row.lastActivity))
      ? row.lastActivity
      : new Date(now).toISOString()
    const tail = row.permalink.replace(/^https?:\/\/[^/]+\/archives\//, '').replace(/[?#].*$/, '')
    return {
      id: `slack:${tail}`,
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

/**
 * Run one headless scan. Throws on timeout or when the connector is missing;
 * the caller decides how that degrades (notice + retry on the next sync).
 */
export async function scanSlack(timeoutMs = 180_000): Promise<WorkItem[]> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  try {
    const q = query({
      prompt: SCAN_PROMPT,
      options: {
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user'],
        allowedTools: READ_ONLY_SLACK_TOOLS,
        abortController: abort,
      },
    })
    let text = ''
    for await (const msg of q) {
      const m = msg as { type: string; subtype?: string; result?: string }
      if (m.type === 'result') {
        text = typeof m.result === 'string' ? m.result : ''
        break
      }
    }
    if (text.includes('"no-slack-tools"')) {
      throw new Error('no Slack tools — enable Slack for Claude at claude.ai/settings/connectors')
    }
    return normalizeSlackRows(parseAgentItems(text))
  } finally {
    clearTimeout(timer)
  }
}
