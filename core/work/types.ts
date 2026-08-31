/**
 * Work items — ported from hey-triage (src/core/types.ts), trimmed to what
 * the web inbox renders. Kinds for sources not yet ported (slack, linear)
 * are kept: scoring is source-agnostic and the ids/kinds are settled.
 */
export type WorkSource = 'github' | 'slack' | 'linear' | 'manual'

export type ItemKind =
  | 'review-requested' // someone asked you to review their PR
  | 'reply-needed' // changes requested on your PR — reviewer is waiting on you
  | 'own-pr-approved' // approved but unmerged — merge it
  | 'own-pr-conflicting' // your PR has merge conflicts
  | 'own-pr-stale' // your PR, no activity for days
  | 'own-pr-open' // your PR, healthy, waiting on review
  | 'mention' // you were mentioned somewhere
  | 'slack-reply-pending'
  | 'slack-mention'
  | 'ticket-assigned'
  | 'watch-hit' // a user-defined watch matched this thread (see .docs/watches.md)
  | 'manual' // a to-do the user added by hand, in the inbox
  | 'fyi'

export type Group = 'blocking' | 'blocked-stale' | 'cycle' | 'fyi'

export const GROUP_LABELS: Record<Group, string> = {
  blocking: 'YOU ARE BLOCKING',
  'blocked-stale': 'YOUR WORK — STALE',
  cycle: 'YOUR CYCLE',
  fyi: 'FYI',
}

export interface WorkItem {
  /** stable id, e.g. "github:owner/repo#123" */
  id: string
  source: WorkSource
  kind: ItemKind
  title: string
  url: string
  /** repo, Slack channel, or Linear team — the item's home */
  repo: string
  author: string
  /** humans waiting on *you* for this item */
  peopleWaiting: number
  createdAt: string
  updatedAt: string
  isDraft?: boolean
  ciFailing?: boolean
  /** Linear priority: 1 urgent, 2 high, 3 normal, 4 low (0/absent = none) */
  priority?: number
  /** canonical refs extracted from content, e.g. "github:org/repo#123", "linear:NOV-456" */
  refs?: string[]
  /** which watch produced it (undefined = built-in) */
  watchId?: string
  /** the project this item belongs to (manual items; empty = none) */
  projectId?: string
  /** scanner's one-line match reason (rendered on the item) */
  why?: string
  /** re-armed: was done/snoozed, the source updated afterwards */
  returned?: boolean
}

export interface ScoredItem extends WorkItem {
  score: number
  group: Group
  /** one human-readable line: why this ranked where it did */
  reason: string
  /** items sharing a canonical ref, folded into this card (linked, not merged) */
  linked?: { source: WorkSource; url: string; repo: string }[]
}
