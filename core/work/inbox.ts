/**
 * Inbox orchestration — ported (adapted) from hey-triage (src/core/inbox.ts):
 * fetch deterministic sources fresh, merge in cached connector-backed items,
 * score. A source failing never breaks the inbox; it degrades to a notice.
 *
 * Slack items arrive pre-fetched: the scan runs through a Claude session
 * (slow, costs tokens), so the server caches it with a TTL and scans in the
 * background — never in this call's critical path.
 */
import { fetchGitHub } from '../sources/github.js'
import { rank } from './score.js'
import type { ScoredItem, WorkItem } from './types.js'

export interface InboxOptions {
  /** owner/name repos to scope GitHub to; empty = all repos */
  repos: string[]
  /** cached Slack items (already normalized), plus an optional status notice */
  slack: { items: WorkItem[]; notice?: string }
}

export interface InboxResult {
  items: ScoredItem[]
  /** degraded/skipped sources, for a gray line in the frontends */
  notices: string[]
}

export async function refreshInbox(opts: InboxOptions): Promise<InboxResult> {
  const notices: string[] = []
  const items: WorkItem[] = []

  const [ghRes] = await Promise.allSettled([fetchGitHub(opts.repos)])
  if (ghRes.status === 'fulfilled') items.push(...ghRes.value)
  else notices.push(`github: ${(ghRes.reason as Error).message}`)

  items.push(...opts.slack.items)
  if (opts.slack.notice) notices.push(opts.slack.notice)

  return { items: rank(items), notices }
}
