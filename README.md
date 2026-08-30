# triage-dev

POC: a Hermes-style local web UI over the **locally installed Claude Code**, driven via
`@anthropic-ai/claude-agent-sdk`. No API key — it uses your existing Claude Code login
(subscription), and it loads your user-level settings, plugins, and claude.ai connectors.

## Run

```sh
npm install
npm run dev          # → http://localhost:5179  (Vite dev server, proxies to :5178)
```

`npm run dev` starts both halves: the node server on `:5178` (API + WebSocket) and Vite
on `:5179`, which proxies `/api` and `/ws` back to it. Open the Vite URL — HMR applies to
the UI, and live sessions survive it.

The server is deliberately **not** run under `tsx watch`: restarting it kills every live
Claude subprocess. Restart it by hand when you change `server/`.

For a production-style run on a single port:

```sh
npm run build && npm start   # → http://localhost:5178
```

## What it does

- **Sessions**: "+ New session" spawns a long-lived Claude Code subprocess
  (streaming-input mode) in the working directory you choose. Each session is a
  back-and-forth chat — send follow-ups any time. Open a session in its own tab
  with the ↗ link (`/#<sessionId>`).
- **Streaming**: assistant text streams token-by-token over WebSocket
  (`includePartialMessages` → `stream_event` deltas).
- **Tool calls**: rendered as collapsible cards (input + result).
- **Permissions**: the SDK's `canUseTool` callback surfaces Allow/Deny prompts in the
  browser — your `~/.claude` allowlists still apply first (only unmatched tools prompt).
- **Connectors & plugins**: sessions run with `systemPrompt: claude_code` preset and
  `settingSources: ['user','project','local']`, so your claude.ai connectors (Slack,
  Notion, …) and installed plugins load exactly like an interactive `claude` session.
  The init card in each chat shows the MCP servers and their status.
- **Inbox** (`/#/inbox`): ranked work items — the scoring and sources ported from
  hey-triage. Deterministic scoring, no LLM in the scoring path.
  - **GitHub** via `gh`: review requests, your PRs classified as
    conflicting/approved/stale/open, mentions. Scoped to the **connected repos**
    (the "Repos" picker on the page; nothing selected = all repos, noisy). The
    selection lives in the `config` KV table.
  - **Slack** via the claude.ai Slack connector, when the connector probe says
    it's connected: a headless read-only Claude session scans for mentions and
    reply-pending threads and returns strict JSON (`core/sources/slack.ts`).
    It costs tokens and ~a minute, so it runs in the **background** with a
    30-min cached TTL — never in the inbox view's critical path; the page shows
    a gray notice while a scan is in flight and the snapshot updates when it
    lands. This repo never holds Slack credentials.
  - **No cron**: the server is the long-running process — sync happens on view
    when the 5-min TTL has lapsed, on Refresh, and on a 15-min keep-warm
    interval; the latest snapshot persists in SQLite (one replaced-wholesale
    row — a cache of what sources said, not our data) so first paint is instant
    even after a restart. A laptop that slept just syncs on the next view.
  - **Dispatch** prefills a new session with the item's context; when a project
    is tied to the item's repo, the session lands in that project's folder.
- **Watches** (`/#/watches`): user-defined ingestion rules (design:
  `.docs/watches.md`) — one plain-English sentence, scoped to a `#channel` or
  `@dm`, on an hourly/daily/weekly cadence. Creation flow: plain text → LLM
  draft into an editable form → **required preview** against the scope's last
  week (each match with a why-line) → create. The scanner LLM only answers
  "does this match — yes/no + why" and extracts refs; identity, de-dupe,
  scheduling, and scoring are all code. Due watches run as **one composed
  scan** with the built-in Slack rules (a minute-tick due-checker, not cron —
  missed runs coalesce and cursor-based reads make the coalesced run lossless).
  Matches land in the inbox as `watch-hit` items (base 40 — mentions and
  reviews outrank topical matches) with the watch chip, why-line, and a 👎
  that appends a correction to the instruction text. Items sharing an
  extracted ref (e.g. a Slack ask about PR #123) render as **one card, both
  sources shown**, +10 multi-source bonus — linked by string equality, never
  by LLM judgment.
- **Done / snooze / dismiss**: `e` done, `z` snooze until tomorrow, `x` dismiss.
  User state lives in its own `item_state` table and survives every snapshot
  rebuild; a done item whose source updates afterwards **re-arms** and returns
  with a `↩ returned` marker (dismissed never re-arms).
- **Ingestion API**: `POST /api/items/upsert` (idempotent: id-keyed,
  update-only-if-newer, user-state-preserving; invalid items are rejected,
  never repaired) and `POST /api/items/resolve`. Also exposed as MCP tools
  (`list_work_items` / `upsert_work_item` / `resolve_work_item`) via the
  dependency-free stdio shim: `claude mcp add triage -- npx tsx
  <repo>/server/mcp.ts` (set `TRIAGE_URL` if not on :5178). The power-user
  recipe: any Claude Code routine or cron'd headless session can *be* a
  watch-runner — "read X, find Y, call `upsert_work_item`" — and cannot create
  duplicates or clobber user state.
- **Projects** (`/#/projects`): name + optional repo + local folder. The session
  dialog gets a project picker; dispatch matches `item.repo` → project folder.
  Folder paths are validated server-side (`stat`) at creation.
- **Keyboard + command center**: `⌘K`/`Ctrl+K` palette (actions, pages, "new
  session in <project>", jump to session, dispatch work items — filterable);
  `g i`/`g w`/`g p`/`g c` page navigation, `n` new session, `?` shortcuts overlay;
  inbox: `j`/`k` select, `Enter`/`o` open, `d` dispatch, `e` done, `z` snooze,
  `x` dismiss, `r` refresh. Single-key hotkeys stay quiet while typing or while
  any dialog is open.
- **Connectors page** (`/#/connectors`): every claude.ai connector and local MCP
  server a session will load, with live status (connected / needs auth / failed).
  Probed honestly — the server spawns a throwaway SDK query with the same options
  real sessions use and asks it via the `mcpServerStatus()` control request (no
  user message, so no API cost). Cached; Refresh re-probes. "Connectors" (claude.ai's
  own word), not "Integrations" — that name is reserved for future inbox *sources*.

## Architecture

```
shared/protocol.ts   the WebSocket contract — imported by BOTH server and web, so a
                     wire-format change is a compile error on whichever side lags
core/store/          the persistence seam: async repository interfaces (types.ts)
                     + the SQLite adapter (node:sqlite — zero deps). A Postgres
                     adapter for a hosted version implements types.ts, not sqlite.ts
server/index.ts      http :5178 (JSON API + the built SPA) + WebSocket /ws
                     LiveSession = AsyncQueue<SDKUserMessage> → query() → event pump
                     events broadcast to all clients AND persisted (write-through)
web/                 Vite + React + TS frontend, built to dist/web
  src/store.ts       the client's view of the server, as an external store
  src/transcript.ts  pure fold of a session's event log into renderable items
```

The frontend is thin by construction: it knows `shared/protocol.ts` and nothing else
about the server (see `.docs/vision.md`, "thin frontends, fat core").

### Persistence & resume

Sessions and their event logs live in SQLite at `~/.triage/triage-dev.db`
(override with `TRIAGE_DB`). Two tables: `sessions` (including `sdk_session_id`,
captured from the SDK's init message) and `session_events` (append-only,
`(session_id, seq)`-keyed, stream deltas excluded).

The Claude subprocess is ephemeral. A session with no live subprocess is revived
on the next user message via the SDK's `resume: sdkSessionId` — Claude Code
replays its own transcript from `~/.claude/projects/…` into the new subprocess.
The division of labor is deliberate: **our event log restores the page; `resume`
restores the agent.** Nothing in `session_events` is ever fed back to the model.

Permission prompts don't survive their subprocess: on process exit (and at boot,
for prompts orphaned by a previous server run) unanswered requests are resolved
as `expired` so the UI never shows an Allow button that can't apply.

### Rendering the stream

Token deltas arrive far faster than anything should re-render, so the store has two
notification channels:

- **structural** — sessions, connection state, committed events. Fires once per SDK
  message.
- **live** — the in-flight assistant line. Deltas are buffered and flushed on
  `requestAnimationFrame`, and only `<LiveLine>` subscribes, so a burst of tokens
  re-renders one text node and leaves the rest of the transcript alone.

`buildTranscript()` is a pure function memoised on the events array, so the fold runs
once per committed event rather than once per frame.

### WS protocol

Client → server: `create_session {title, cwd, firstMessage?}`, `subscribe {sessionId}`,
`user_message {sessionId, text}`,
`permission_response {sessionId, requestId, behavior}`, `interrupt {sessionId}`.
Server → client: `hello`, `sessions`, `session_created`, `history`, `session_event`,
`error`. Incoming frames are validated into the union rather than cast — the socket is
untrusted input.

## Scripts

| script | what it does |
| --- | --- |
| `npm run dev` | server + Vite dev server together |
| `npm run dev:server` / `npm run dev:web` | either half on its own |
| `npm run build` | Vite production build → `dist/web` |
| `npm start` | server only, serving `dist/web` on `:5178` |
| `npm run typecheck` | `tsc` over both projects |
| `npm run smoke` | end-to-end test over WS against a running server; expects "POC OK" |

React and Vite are **devDependencies** — the published package ships the built `dist/`,
so a global install pulls only the runtime deps (`ws`, the Agent SDK). Keeping it that
way is what makes "minimal dependencies" (vision principle 5) compatible with a build
step.

## Known POC limits

- One subprocess per session; nothing caps concurrency.
- No task list / GitHub integration yet — this POC is the session+chat layer that a
  ranked inbox would dispatch into.
- claude.ai connectors that show `needs-auth` need their OAuth done once in interactive
  `claude` (`/mcp`); the headless session then picks the tokens up.
