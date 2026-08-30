# Roadmap

> Status: **committed 2026-08-30**, after market research + the first-user interview.
> Full findings: "The Triage Wow Map" artifact
> (https://claude.ai/code/artifact/7bc0872e-3bdf-41f5-ab7d-0d40a0196f13).
> The interview corrected the research in one big way: for our first user, **Slack is
> the front door, not GitHub** — review requests arrive in a team Slack channel, the
> weekly plan as a manager's thread with per-person assignments, urgent asks as DMs.

## The product concept

**Every work item arrives with its action already drafted.** A review request arrives
as a risk brief (verdict, blockers, risky hunks, blast radius, what the CI bots
flagged). A mention arrives with a draft reply. A red CI arrives with an attempted fix
awaiting push approval. The inbox is not a list of things to do — it is a list of
things *almost done, awaiting judgment*.

The safety model, in the first user's own words: **read-only runs itself; outward
writes wait for you.** Reviews are computed but never posted. Replies are drafted for
copy-paste (no Slack write scopes, ever — see vision non-goals). Pushes are gated on
approval.

### The first-user test (exit criterion for v0.2)

One full workday run through triage where:

- every review request (Slack channel, DM, or GitHub) surfaced **with a brief already
  computed** — none handled later than same-day;
- the weekly-plan assignments, mentions, and contributable threads all appeared ranked —
  **zero items discovered via a teammate's reminder**;
- every parked Claude session was re-entered from the inbox in one glance, with a
  how-to-verify note;
- drafted replies were copy-pasted, done items re-armed on new activity;
- total coordination time (morning triage + re-entries + standup) **under one hour**,
  measured.

## v0.1 — the loop, end to end

The wedge, nothing else: ranked inbox → dispatch → steer from the browser.

- [x] Server + web UI shell (`triage` starts server, prints URL) — POC done
- [x] Session layer: streaming chat, tool cards, permission prompts — POC done
- [x] Session persistence & resume across server restarts (SDK `resume`) — POC done (SQLite via `core/store`)
- [x] Work-items page: ranked GitHub inbox — POC done (`core/work`, `core/sources/github`, `/#/inbox`)
- [~] Dispatch: work item → session pre-loaded with context — prefilled dialog done; full context preload moves to v0.2 (it becomes "briefs")
- [ ] Localhost hardening: 127.0.0.1 bind, Origin check, URL auth token
- [ ] Ten-second first run: `npx triage` → detect `gh` auth + installed Claude Code → the user's real morning, ranked, no config wall (graceful no-agent mode)

## v0.2 — the front door + briefs (the identity release)

Everything here comes straight from the interview. This is the release that must pass
the first-user test.

**Slack as the front door** (churn-critical: "still juggling 5 tools" = uninstalled)
- [ ] DMs as work items (a missed DM review request cost a teammate hours)
- [ ] PR-review channel: parse requests, match against "my code / parts I've worked on"
- [ ] Weekly-plan thread ingestion: manager's per-person assignments become tracked items with plan lineage
- [ ] Contributable conversations: threads with no mention where the user has something to add (detection may use the existing headless scan; **scoring stays deterministic**)

**Watches + ingestion engine** — full design: `watches.md` (handover-ready)
- [ ] `watches` table + user-state overlay (`item_state`) with re-arm rule
- [ ] Creation modal: plain text → structured draft → **preview against history** → create
- [ ] Due-checker scheduling (anacron-style: missed runs coalesce, cursor-based scans make it lossless)
- [ ] Composed scan (built-ins + due watches in one headless session), strict-JSON validated
- [ ] Deterministic de-dupe/upsert (id-keyed, update-only-if-newer, user state never touched by ingestion)
- [ ] Cross-source linking via extracted refs (link + score bonus, never LLM-merge)
- [ ] MCP ingestion API: idempotent `upsert_work_item` / `list` / `resolve` — external scanners (Claude routines, cron'd sessions) become first-class watch-runners; correctness lives in the contract, not the prompt

**Briefs — playbooks that auto-run before you arrive**
- [ ] Playbooks as user-editable skills (markdown the sessions already load), shipped with opinionated per-kind defaults
- [ ] `review-requested` → risk brief: verdict + blockers, bad practices, risky hunks, blast radius, bot flags (Cursor/Codex comments), manual-test flow when relevant. Computed in the background, **never posted to GitHub**
- [ ] `slack-reply-pending` / mention → draft reply for copy-paste
- [ ] Contributable thread → summary + suggested message
- [ ] `ciFailing` on own PR → attempted fix; push gated on approval
- [ ] Linear ticket / big items → manual dispatch only (user picks, then full-context preload)

**The queue itself**
- [ ] Sessions in the inbox: parked/finished sessions surface as ranked items carrying *what it did*, *what it asks*, *how to verify* — cheap re-entry, deliberately not a faster interrupt
- [ ] Self-clearing: items complete themselves when reality changes (review submitted, PR merged, CI green, thread answered)
- [ ] Self-re-arming: a "done" thread reopens when newer messages land
- [ ] Snooze / dismiss / pin; a designed inbox-zero state
- [ ] Explainable score: click a score → the exact arithmetic

## v0.3 — bookends + the verify loop

- [ ] Morning brief: what landed overnight, what agents finished, top three now (deterministic data, not LLM vibes)
- [ ] The standup that writes itself: end-of-day draft from observed activity (sessions, reviews, merges, replies, plan items advanced) — copy-paste to Slack
- [ ] Review-the-agent: diff cards in transcript + inbox; comment on a line → steers the session; approve → commit/push from the page
- [ ] CI failures as a first-class source (items of their own, logs preloaded — currently only a score modifier)
- [ ] Worktree parallel dispatch (table stakes, done quietly — never marketed as the product)
- [ ] Follow-up re-enqueue: a session ending with open questions files a new inbox item instead of dying in a tab

## Later / unscheduled

- [ ] Linear/Jira as sources (types + priority boosts already modeled)
- [ ] Teleport: "continue this session in your terminal" via `claude --resume <id>`
- [ ] Overnight mode: opt-in, tightly allowlisted autonomous handling of low-risk kinds — only after the verify loop has earned trust
- [ ] Cost/usage readout + background budget dial (first user: "I don't care about quota"; others will)
- [ ] Watch suggestions learned from dispositions (layer 3 — see `watches.md`, needs usage data first)
- [ ] Semantic watches over GitHub/Linear content (same engine as Slack watches)
- [ ] Other agent adapters behind the same interface (Codex, etc.)
- [ ] Hosted team version (own API-backed Claude) — parked, see vision.md

## Guardrails (from the research post-mortems)

- The graveyard is thin session-manager wrappers (Terragon, Vibe Kanban, Crystal,
  Copilot Workspace, Octobox). Identity investment goes to inbox + briefs; session
  mechanics are plumbing.
- No greedy scopes: `gh`-scoped, local-first, read-only by default, no Slack
  credentials in this repo — and say so loudly.
- Demo on live personal data, never fixtures (structurally cherry-pick-proof).
- The pitch is *your morning, shorter* — never *you, a manager of 30 agents*.

## Open questions

- Does the existing hey-triage repo become this (web-first pivot + DECISIONS entry), or
  does triage-dev graduate into the real repo?
- Package name: `@hey-triage/triage` vs `hey-triage`?
- Weekly-plan thread parsing: per-team config or a playbook skill the user points at
  their plan channel?
