/**
 * Inbox orchestration — ported (adapted) from hey-triage (src/core/inbox.ts):
 * fetch deterministic sources fresh, merge in cached connector-backed items
 * and persisted ingested items (watch hits, external upserts), apply the
 * user-state overlay, score, link. A source failing never breaks the inbox;
 * it degrades to a notice.
 *
 * Slack items arrive pre-fetched: the scan runs through a Claude session
 * (slow, costs tokens), so the server caches it with a TTL and scans in the
 * background — never in this call's critical path.
 */
import { fetchGitHub } from '../sources/github.js'
import { linkByRefs } from './link.js'
import { BASE, rank } from './score.js'
import { applyOverlay, type ItemState } from './state.js'
import type { ScoredItem, WorkItem } from './types.js'

export interface InboxOptions {
  /** owner/name repos to scope GitHub to; empty = all repos */
  repos: string[]
  /** cached Slack items (already normalized), plus an optional status notice */
  slack: { items: WorkItem[]; notice?: string }
  /** persisted ingested items: watch hits + external-scanner upserts */
  ingested: WorkItem[]
  /** user-authored to-dos added by hand in the inbox */
  manual: WorkItem[]
  /** the user-state overlay, keyed by item id */
  states: Map<string, ItemState>
  now?: number
}

export interface InboxResult {
  items: ScoredItem[]
  /** degraded/skipped sources, for a gray line in the frontends */
  notices: string[]
  /** ids the re-arm rule reopened — the caller persists the transition */
  rearmed: string[]
}

/**
 * The same thread can be both a built-in hit (a mention) and a watch hit —
 * one item wins by base weight, but keeps the watch's why/refs so the card
 * still explains itself. De-dupe is deterministic, never LLM-based.
 */
export function mergeById(items: WorkItem[]): WorkItem[] {
  const byId = new Map<string, WorkItem>()
  for (const item of items) {
    const prior = byId.get(item.id)
    if (!prior) {
      byId.set(item.id, item)
      continue
    }
    const [win, lose] = BASE[item.kind] > BASE[prior.kind] ? [item, prior] : [prior, item]
    byId.set(item.id, {
      ...win,
      watchId: win.watchId ?? lose.watchId,
      why: win.why ?? lose.why,
      refs: win.refs ?? lose.refs,
    })
  }
  return [...byId.values()]
}

export async function refreshInbox(opts: InboxOptions): Promise<InboxResult> {
  const now = opts.now ?? Date.now()
  const notices: string[] = []
  const items: WorkItem[] = []

  const [ghRes] = await Promise.allSettled([fetchGitHub(opts.repos, now)])
  if (ghRes.status === 'fulfilled') items.push(...ghRes.value)
  else notices.push(`github: ${(ghRes.reason as Error).message}`)

  items.push(...opts.slack.items)
  if (opts.slack.notice) notices.push(opts.slack.notice)
  items.push(...opts.ingested)
  items.push(...opts.manual)

  const { visible, rearmed } = applyOverlay(mergeById(items), opts.states, now)
  return { items: linkByRefs(rank(visible, now)), notices, rearmed }
}
