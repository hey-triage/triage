# Watches — ingestion engine design (development handover)

> Status: **designed 2026-09**, from the first-user brainstorm sessions. Companion to
> `roadmap.md` (v0.2) and `vision.md` ("The brief"). Research grounding lives in the
> "Triage Wow Map" artifact.

## What a watch is

**A watch = one plain-English sentence, scoped to a place, that tells the scanner what
the user cares about.** Example: scope `#novus-px`, instruction "threads discussing
product experience — user friction, UX decisions, PX metrics; not release-note chatter."

Conceptually a watch is a packaged routine (NL instructions + schedule + connector
read). We are not pretending otherwise. What the packaging adds — and what a DIY
routine lacks — is everything *after* the run: deduped work items, deterministic
scoring against every other source, done/re-arm lifecycle, why-lines, preview,
one-sentence authoring. **The scanner is fungible; the inbox is the product.**

## The three layers

1. **Built-ins** — our rules, on by default, zero config beyond a pointer (e.g. *which*
   channel is the review channel). GitHub/Linear built-ins run as plain code (`gh`,
   API). Slack built-ins (mentions needing reply, unreplied DMs, review-channel
   requests, plan-thread assignments) run through the headless LLM scan because the
   claude.ai connector is our only Slack access — the LLM is the *reader*, the rules
   are ours and fixed.
2. **Watches** — user-defined, UI-created, stored in SQLite (this document).
3. **Learned suggestions** — later. The app proposes watches from observed behavior
   (always-dismissed channels, always-dispatched topics). Out of scope for v0.2.

## Design rules (non-negotiable)

- **LLM reads and extracts; code decides identity, schedule, and score.** The LLM
  answers exactly one judgment per candidate: "does this match the watch sentence —
  yes/no (+ a one-line why)." It also *extracts* verifiable facts (URLs, refs,
  timestamps). It never scores, never merges, never decides done.
- **De-dupe is deterministic, never LLM-based.** A wrong merge hides a work item;
  hidden items are the product's stated churn-killer. Duplicates are annoying; swallowed
  items are fatal.
- **Correctness lives in the contract, not the prompt.** The ingestion API is an
  idempotent upsert; even a sloppy external scanner cannot create duplicates or clobber
  user state.
- **Scans are read-only by construction** (tool allowlist, as in
  `core/sources/slack.ts`). Watches never write to Slack/GitHub.
- **Storage rule:** instructions agents read → filesystem (playbook skills); data the
  server manages → SQLite. Watches are server-managed config rows → SQLite.

## Data model (SQLite, via `core/store/types.ts`)

```sql
CREATE TABLE watches (
  id            TEXT PRIMARY KEY,       -- uuid
  source        TEXT NOT NULL,          -- 'slack' (v0.2: slack only)
  title         TEXT NOT NULL,          -- "PX topics in #novus-px"
  scope         TEXT NOT NULL,          -- '#novus-px' | '@dm' — code-enforced boundary
  instruction   TEXT NOT NULL,          -- the NL sentence; editable forever
  cadence       TEXT NOT NULL,          -- 'hourly' | 'daily' | 'weekly'
  window_start  TEXT,                   -- daily/weekly: local time "09:00"
  window_day    INTEGER,                -- weekly: 0-6
  enabled       INTEGER NOT NULL DEFAULT 1,
  creates_items INTEGER NOT NULL DEFAULT 1,  -- no = FYI-only rows (fyi kind)
  cursor        TEXT,                   -- last-seen watermark (ts of newest scanned msg)
  last_run_at   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
```

Work-item additions (`core/work/types.ts`):

```ts
interface WorkItem {
  // ...existing fields...
  refs?: string[]     // canonical refs extracted from content, e.g. "gh:org/repo#123", "linear:NOV-456"
  watchId?: string    // which watch produced it (undefined = built-in)
  why?: string        // scanner's one-line match reason (rendered on the item)
}
```

New kind: `watch-hit` (base score ~40 in `core/work/score.ts` — deliberately modest;
mentions and reviews must outrank topical matches by default).

**User-state overlay** — the snapshot stays a replaced-wholesale cache of what sources
said (existing principle); user state must survive it, so it lives in its own table
keyed by item id:

```sql
CREATE TABLE item_state (
  item_id      TEXT PRIMARY KEY,       -- WorkItem.id
  status       TEXT NOT NULL,          -- 'open' | 'done' | 'snoozed' | 'dismissed'
  status_at    TEXT NOT NULL,
  snooze_until TEXT,
  pinned       INTEGER NOT NULL DEFAULT 0
);
```

**Re-arm rule (code):** `status = 'done'` (or snooze elapsed) AND snapshot
`updatedAt > status_at` → status resets to `open`, item renders with a "returned"
marker. Dismissed items do not re-arm.

## Creation flow (UI)

1. **"+ Add watch"** → modal. User types plain text: *"watch #novus-px for product
   experience related messages"*.
2. **Draft step**: one LLM call parses it into the structured form — title, scope,
   instruction, suggested cadence, creates-items toggle. Every field editable. Ship
   3–4 starter templates ("watch a channel for a topic", "questions in my area")
   instead of a blank box.
3. **Preview step (required)**: run the draft against the scope's recent history
   (~1 week) and show the threads it *would have* matched, each with a why-line. This
   is the trust-maker (Superhuman precedent; Notion Mail died without rule
   re-testing). Bad matches → user edits the sentence → re-preview.
4. **Create** → row in `watches`, active on the next scheduler tick.

Editing reopens the same modal (with re-preview). A thumbs-down on a matched item
offers "refine this watch": the correction is appended to the instruction text — the
rule stays human-readable, never opaque weights.

## Scheduling — due-checker, not cron

No fire-time queue, no cron table. Store `last_run_at`; a scheduler tick in the
long-running server (every minute, alongside the existing keep-warm interval) asks
**"is it due?"**:

```
hourly        → due if now - last_run_at ≥ 1h
daily  @09:00 → due if now ≥ today@09:00 AND last_run_at < today@09:00
weekly Mon    → due if now ≥ thisWeek(Mon)@window AND last_run_at < thisWeek(Mon)@window
due → run once → last_run_at = now
```

Both laptop-reality requirements fall out automatically:

- **Missed runs execute on wake** (first tick after boot/sleep finds them due).
- **Coalescing is structural**: a watch that missed 9:00/10:00/11:00 is simply *due*
  at 12:00 — once. The design cannot run it four times.
- **Coalescing is lossless** because scans are **cursor-based**: each run reads
  "messages since `cursor`", not "messages from the last hour". The 12:00 run covers
  the whole gap, then advances the cursor.

This is the codebase's existing idiom (inbox TTL-on-view + keep-warm; "a laptop that
slept just syncs on the next view") — watches join the same loop.

## Scan execution

One composed scan per due batch, not one session per watch:

1. Collect all due Slack work (built-in rules + due watches).
2. Compose a single scan prompt: the fixed built-in sections + one section per watch
   (scope, cursor, instruction). Same headless pattern as `core/sources/slack.ts`
   (read-only allowlist, `settingSources: ['user']`, timeout, abort).
3. Output contract: strict JSON rows only —
   `{title, permalink, channel, from, lastActivity, kind|watchId, why, refs[]}`.
   Parse with the existing start/end-bracket + per-row validation; malformed rows are
   discarded, never repaired.
4. Normalize → upsert (below) → deterministic scoring, unchanged.

**Cost controls:** channel-scoped reads; cursor-incremental; judge on snippets (title +
first ~200 chars) not whole threads; cap rows per watch (15); record per-scan token
usage on the watch row (surfaced in the watch list UI).

## De-dupe and upsert (all code, no LLM)

- **Identity**: stable ids are the dedupe key — `slack:<permalink-tail>` (one item per
  thread), `github:owner/repo#123`. Same scheme for external scanners.
- **Upsert rule**: id exists → update only if incoming `updatedAt` is newer (refresh
  title/peopleWaiting/refs/updatedAt — re-ranking is correct, waiting time grew);
  otherwise touch nothing. Id new → insert.
- **User state is never written by ingestion.** The overlay table is the user's; the
  only ingestion-triggered transition is the re-arm rule above.

## Cross-source linking (the "Slack asks for review of PR #123" case)

Two items about the same work get **linked, not merged**:

- The scanner *extracts* refs it can see in content (PR/issue URLs, Linear keys) into
  `refs[]`, canonicalized by code (`gh:org/repo#123`, `linear:NOV-456`). Extraction is
  verifiable; judgment is not.
- Items sharing a canonical ref render as **one card, both sources shown** ("requested
  on GitHub + asked in #novus-india"). Deterministic score for the card: max of the
  linked items' scores **+10 multi-source bonus** (two signals about the same work =
  more urgent). Completing the underlying work clears the whole card via each item's
  own self-clear conditions.
- **No shared ref → never auto-linked.** Similar-looking items may render adjacently
  as "possibly related" with a one-key manual link; the LLM never silently decides two
  items are one.

## MCP ingestion API (promoted to v0.2)

The triage MCP server is not just a read surface — it is the ingestion contract that
makes external scanners first-class:

- `list_work_items(filter?)` — read the queue.
- `upsert_work_item(item)` — **idempotent**: id-keyed, update-only-if-newer,
  user-state-preserving (all rules above enforced server-side). Validates id format
  and required fields; rejects rather than repairs.
- `resolve_work_item(id)` — mark done (subject to re-arm like any done).

This means a Claude Code routine, a cron'd headless session, or gh-aw workflow can
*be* a watch-runner: "read #channel, find X, call upsert_work_item" — no fetch-and-check
steps in the prompt, and it cannot create duplicates or clobber state. Document this as
the power-user recipe (it also covers laptop-off scanning via cloud routines).

## UI surfaces

- **Watches page** (or a Connectors-page section): list with enabled toggle, cadence,
  last run, match count, last-scan token cost; add/edit modal per the creation flow.
- **On each watch-hit item**: the `why` line (alongside the deterministic `reason`),
  the watch's title as a chip, thumbs-down → refine.
- **Command palette**: "Add watch", "Pause watch <title>".

## Out of scope (deliberate)

- Layer 3 (learned suggestions) — needs months of disposition data.
- Watches over GitHub/Linear content (semantic repo watches) — same engine later;
  Slack first because that's where unstructured work arrives.
- Visual pipeline/automation builder — rejected; see research (rule rot, low
  adoption). The pipeline collapses to "a filter per scope" = a watch.
- Per-watch model selection, watch quotas — revisit only if scan costs surprise us.

## Open questions

- Multiple Slack workspaces: scope syntax (`workspace/#channel`) or per-workspace
  connector probing?
- Preview cost UX: show estimated tokens before running the creation preview?
- Does `creates_items: no` (FYI-only) earn its complexity in v0.2, or ship yes-only?
