/**
 * Folds a session's event log into a flat list of renderable items.
 *
 * Pure and memoisable: the events array only ever grows by append, so this runs
 * once per committed event, not once per token. Tool results arrive in a later
 * `user` message than the `tool_use` that produced them, so they are stitched
 * back onto their card here rather than in a component.
 */
import {
  isTextBlock,
  isThinkingBlock,
  isToolResultBlock,
  isToolUseBlock,
  type McpServerInfo,
  type PermissionBehavior,
  type QuestionAnswers,
  type RawBlock,
  type SessionEvent,
} from '../../shared/protocol.js'

export type ToolResult = { text: string; isError: boolean }

export type TranscriptItem =
  | { key: string; kind: 'user'; text: string }
  | { key: string; kind: 'assistant'; text: string }
  | { key: string; kind: 'thinking'; text: string }
  | { key: string; kind: 'error'; text: string }
  | { key: string; kind: 'meta'; text: string }
  | { key: string; kind: 'init'; model?: string; toolCount: number; servers: McpServerInfo[] }
  | {
      key: string
      kind: 'tool'
      name: string
      input: Record<string, unknown>
      result?: ToolResult
    }
  | {
      key: string
      kind: 'permission'
      id: string
      toolName: string
      input: Record<string, unknown>
      title?: string
      canAlwaysAllow?: boolean
      resolved?: PermissionBehavior | 'expired'
      /** AskUserQuestion only: what the user picked, for the replayed card. */
      answers?: QuestionAnswers
    }

export function buildTranscript(events: readonly SessionEvent[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  // A second init in one log means the subprocess was restarted (`resume`) —
  // render those as a one-line marker instead of repeating the full card.
  let initSeen = false
  // Items are rebuilt on every append, so late-arriving results and permission
  // verdicts are patched onto the item objects created earlier in this pass.
  const toolsById = new Map<string, Extract<TranscriptItem, { kind: 'tool' }>>()
  const permsById = new Map<string, Extract<TranscriptItem, { kind: 'permission' }>>()

  events.forEach((ev, i) => {
    switch (ev.kind) {
      case 'local_user':
        items.push({ key: `u${i}`, kind: 'user', text: ev.text })
        break
      case 'error':
        items.push({ key: `e${i}`, kind: 'error', text: ev.message })
        break
      case 'permission_request': {
        const item = {
          key: `p${i}`,
          kind: 'permission' as const,
          id: ev.id,
          toolName: ev.toolName,
          input: ev.input,
          title: ev.title,
          canAlwaysAllow: ev.canAlwaysAllow,
        }
        permsById.set(ev.id, item)
        items.push(item)
        break
      }
      case 'permission_resolved': {
        const item = permsById.get(ev.id)
        if (item) {
          item.resolved = ev.behavior
          item.answers = ev.answers
        }
        break
      }
      case 'sdk': {
        const m = ev.message
        if (m.type === 'system' && m.subtype === 'init') {
          if (initSeen) {
            items.push({ key: `i${i}`, kind: 'meta', text: `— session resumed · ${m.model ?? '?'} —` })
          } else {
            initSeen = true
            items.push({
              key: `i${i}`,
              kind: 'init',
              model: m.model,
              toolCount: m.tools?.length ?? 0,
              servers: m.mcp_servers ?? [],
            })
          }
        } else if (m.type === 'assistant') {
          for (const [j, b] of (m.message?.content ?? []).entries()) {
            if (isTextBlock(b) && b.text.trim()) {
              items.push({ key: `a${i}.${j}`, kind: 'assistant', text: b.text })
            } else if (isThinkingBlock(b) && b.thinking) {
              items.push({ key: `t${i}.${j}`, kind: 'thinking', text: truncate(b.thinking, 400) })
            } else if (isToolUseBlock(b)) {
              const item = {
                key: `c${i}.${j}`,
                kind: 'tool' as const,
                name: b.name,
                input: b.input,
              }
              toolsById.set(b.id, item)
              items.push(item)
            }
          }
        } else if (m.type === 'user') {
          for (const b of m.message?.content ?? []) {
            if (!isToolResultBlock(b)) continue
            const item = toolsById.get(b.tool_use_id)
            if (item) item.result = { text: resultText(b.content), isError: b.is_error === true }
          }
        } else if (m.type === 'result') {
          const cost = m.total_cost_usd != null ? ` · $${m.total_cost_usd.toFixed(4)}` : ''
          const secs = ((m.duration_ms ?? 0) / 1000).toFixed(1)
          items.push({
            key: `r${i}`,
            kind: 'meta',
            text: `— turn done · ${secs}s · ${m.num_turns ?? 0} turns${cost} —`,
          })
        }
        break
      }
    }
  })

  return items
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + ' …' : s
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return (content as RawBlock[])
      .map((c) => (isTextBlock(c) ? c.text : `[${c.type}]`))
      .join('\n')
  }
  return JSON.stringify(content)
}

/** The one-line hint shown next to a tool name in the collapsed card. */
export function toolHint(input: Record<string, unknown>): string {
  for (const k of ['command', 'file_path', 'pattern', 'url', 'description']) {
    const v = input[k]
    if (typeof v === 'string' && v) return ' — ' + truncate(v, 80)
  }
  return ''
}
