#!/usr/bin/env node
/**
 * Triage MCP server (stdio) — the ingestion contract as MCP tools, so any
 * external scanner (a Claude Code routine, a cron'd headless session, a gh-aw
 * workflow) can *be* a watch-runner: "read #channel, find X, call
 * upsert_work_item" — and cannot create duplicates or clobber user state,
 * because every rule is enforced server-side (.docs/watches.md).
 *
 * A thin shim: JSON-RPC 2.0 over stdio (newline-delimited, per the MCP stdio
 * transport), forwarding to the running triage server's HTTP API. Hand-rolled
 * on purpose — no MCP SDK dependency (vision principle 5), and the SQLite
 * single-writer stays the server process.
 *
 *   claude mcp add triage -- npx tsx /path/to/server/mcp.ts
 *   TRIAGE_URL overrides the default http://localhost:5178
 *   TRIAGE_WORKSPACE names the workspace to act in (.docs/workspaces.md);
 *   unset = the default workspace — an external agent never writes into an
 *   ambiguous workspace.
 */
import readline from 'node:readline'

const BASE_URL = (process.env.TRIAGE_URL || 'http://localhost:5178').replace(/\/$/, '')
const WORKSPACE = process.env.TRIAGE_WORKSPACE || ''
const PROTOCOL_VERSION = '2024-11-05'

type JsonRpcRequest = { jsonrpc: '2.0'; id?: number | string; method: string; params?: Record<string, unknown> }

const TOOLS = [
  {
    name: 'list_work_items',
    description:
      'Read the ranked triage queue: every open work item with its deterministic score, group, and reason. Optional filter narrows by source or kind.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['github', 'slack', 'linear'], description: 'only items from this source' },
        kind: { type: 'string', description: 'only items of this kind, e.g. "watch-hit"' },
      },
    },
  },
  {
    name: 'upsert_work_item',
    description:
      'Idempotently upsert one work item into the triage inbox. Id-keyed (e.g. "slack:<permalink-tail>", "github:owner/repo#123"), update-only-if-newer (by updatedAt), user-state-preserving: calling this repeatedly can never create duplicates or clobber done/snoozed/dismissed state. Invalid items are rejected, never repaired.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'stable id: "slack:...", "github:owner/repo#123", or "linear:KEY-123"' },
        kind: { type: 'string', description: 'item kind, e.g. "watch-hit", "mention", "fyi"' },
        title: { type: 'string' },
        url: { type: 'string' },
        repo: { type: 'string', description: 'the item\'s home: repo, Slack channel, or Linear team' },
        author: { type: 'string' },
        peopleWaiting: { type: 'number' },
        createdAt: { type: 'string', description: 'ISO 8601' },
        updatedAt: { type: 'string', description: 'ISO 8601 — the upsert applies only if newer than what is stored' },
        watchId: { type: 'string', description: 'the watch that produced it, if any' },
        why: { type: 'string', description: 'one-line match reason, rendered on the item' },
        refs: { type: 'array', items: { type: 'string' }, description: 'PR/issue URLs or Linear keys seen in the content' },
      },
      required: ['id', 'kind', 'title', 'url', 'updatedAt'],
    },
  },
  {
    name: 'create_work_item',
    description:
      'Add a manual to-do to the inbox (a user-authored item). Title is required; note, url, priority (1–4), and projectId are optional.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'what the to-do is' },
        note: { type: 'string' },
        url: { type: 'string', description: 'an http(s) link' },
        priority: { type: 'number', description: '1 urgent … 4 low' },
        projectId: { type: 'string', description: 'an existing project id' },
      },
      required: ['title'],
    },
  },
  {
    name: 'edit_work_item',
    description:
      'Edit a manual to-do by id (id must start with "manual:"). Only the fields you pass change; priority 0/null clears it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'the manual item id, e.g. "manual:<uuid>"' },
        title: { type: 'string' },
        note: { type: 'string' },
        url: { type: 'string' },
        priority: { type: 'number', description: '1–4, or 0/null to clear' },
        projectId: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'resolve_work_item',
    description:
      'Mark one work item done (by id). Subject to the re-arm rule like any done: if the source updates afterwards, the item returns to the inbox.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
]

async function api(path: string, body?: unknown, method?: string): Promise<unknown> {
  // Scope every call to the configured workspace (?workspace= wins server-side).
  if (WORKSPACE) path += `${path.includes('?') ? '&' : '?'}workspace=${encodeURIComponent(WORKSPACE)}`
  const res = await fetch(`${BASE_URL}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return res.json()
}

async function callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  if (name === 'list_work_items') {
    const body = (await api('/api/inbox')) as { ok: boolean; items?: { source: string; kind: string }[]; error?: string }
    if (!body.ok) return { text: `inbox sync failed: ${body.error}`, isError: true }
    let items = body.items ?? []
    if (typeof args.source === 'string') items = items.filter((i) => i.source === args.source)
    if (typeof args.kind === 'string') items = items.filter((i) => i.kind === args.kind)
    return { text: JSON.stringify(items, null, 2), isError: false }
  }
  if (name === 'upsert_work_item') {
    const body = (await api('/api/items/upsert', args)) as { ok: boolean; outcome?: string; error?: string }
    return body.ok
      ? { text: `ok: ${body.outcome}`, isError: false }
      : { text: `rejected: ${body.error}`, isError: true }
  }
  if (name === 'create_work_item') {
    const body = (await api('/api/items/manual', args)) as { ok: boolean; error?: string }
    return body.ok ? { text: 'ok: created', isError: false } : { text: `rejected: ${body.error}`, isError: true }
  }
  if (name === 'edit_work_item') {
    const { id, ...patch } = args
    if (typeof id !== 'string' || !id) return { text: 'rejected: need a manual item id', isError: true }
    const body = (await api(`/api/items/manual?id=${encodeURIComponent(id)}`, patch, 'PUT')) as {
      ok: boolean
      error?: string
    }
    return body.ok ? { text: 'ok: edited', isError: false } : { text: `rejected: ${body.error}`, isError: true }
  }
  if (name === 'resolve_work_item') {
    const body = (await api('/api/items/resolve', { id: args.id })) as { ok: boolean; error?: string }
    return body.ok ? { text: 'ok: done', isError: false } : { text: `rejected: ${body.error}`, isError: true }
  }
  return { text: `unknown tool: ${name}`, isError: true }
}

function reply(id: number | string, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function replyError(id: number | string, code: number, message: string) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  void (async () => {
    let msg: JsonRpcRequest
    try {
      msg = JSON.parse(line) as JsonRpcRequest
    } catch {
      return // not a JSON-RPC frame — ignore
    }
    if (msg.id === undefined) return // notification (e.g. notifications/initialized)
    try {
      switch (msg.method) {
        case 'initialize':
          reply(msg.id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'triage', version: '0.2.0' },
          })
          break
        case 'ping':
          reply(msg.id, {})
          break
        case 'tools/list':
          reply(msg.id, { tools: TOOLS })
          break
        case 'tools/call': {
          const name = String(msg.params?.name ?? '')
          const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
          const { text, isError } = await callTool(name, args)
          reply(msg.id, { content: [{ type: 'text', text }], isError })
          break
        }
        default:
          replyError(msg.id, -32601, `method not found: ${msg.method}`)
      }
    } catch (err) {
      replyError(msg.id, -32603, err instanceof Error ? err.message : String(err))
    }
  })()
})
