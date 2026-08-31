# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project conventions

- **Commits**: write one-line, short commit messages. Do **not** mention Claude, Claude Code, or add any AI/Co-Authored-By trailer anywhere — commits must read as authored by a real person.
- **UI**: this project uses Radix UI (`@radix-ui/*`). Follow Radix patterns and reach for Radix primitives wherever possible instead of hand-rolling UI behavior.

## Commands

```sh
npm run dev          # server (:5178) + Vite dev server (:5179, proxies /api & /ws) — open the Vite URL
npm run dev:server   # node server only (tsx server/index.ts)
npm run dev:web      # Vite only
npm run build        # vite build → dist/web + tsc → dist
npm start            # server only, serving dist/web on :5178 (production-style, foreground)
npm run typecheck    # tsc over both tsconfig.server.json and tsconfig.web.json
npm run smoke        # end-to-end WS test against a running server (scripts/smoke.mjs)
```

There is no unit-test runner; `npm run smoke` is the end-to-end check and requires a server already running.

The node server is deliberately **not** run under `tsx watch` — restarting it kills every live Claude subprocess. After changing anything in `server/`, restart it by hand. Vite HMR covers the UI and live sessions survive it.

Requires Node ≥ 22.5 (uses `node:sqlite`). React and Vite are devDependencies — the published package ships only `dist/` plus the runtime deps (`ws`, the Agent SDK).

## Architecture

A local web UI over `@anthropic-ai/claude-agent-sdk`. Everything runs on the user's machine; the server binds to localhost, holds no Slack/GitHub credentials, and stores data in SQLite at `~/.triage/triage-dev.db` (override with `TRIAGE_DB`).

- **`shared/protocol.ts`** — the WebSocket contract, imported by **both** server and web, so a wire-format change is a compile error on whichever side lags. The frontend knows this file and nothing else about the server. Incoming WS frames are validated into the union, never cast — the socket is untrusted input.
- **`core/store/`** — the persistence seam: async repository interfaces in `types.ts` + the `node:sqlite` adapter in `sqlite.ts` (zero deps). A hosted Postgres adapter would implement `types.ts`, not `sqlite.ts`.
- **`server/index.ts`** — HTTP `:5178` (JSON API + the built SPA) + WebSocket `/ws`. A `LiveSession` is `AsyncQueue<SDKUserMessage>` → `query()` → an event pump; events are broadcast to all clients **and** persisted write-through.
- **`server/cli.ts`** — the `triage` bin (start/stop/restart/status/logs lifecycle). Liveness is decided by `GET /api/health`, not the pid file.
- **`server/mcp.ts`** — the `triage-mcp` bin, a dependency-free stdio MCP shim over the HTTP API (`list_work_items` / `create_work_item` / `edit_work_item` / `upsert_work_item` / `resolve_work_item`), so an external Claude Code session can drive the inbox. Its tool names/schemas mirror the **in-process** MCP server (`triageMcp` in `server/index.ts`) that every web chat session gets — one contract, two transports. Both, plus the HTTP routes, funnel through the shared `*Op` functions in `server/index.ts` so create/edit/list behave identically everywhere; validation lives once in `workItemFrom`/`manualItemFrom`. In a chat, `list_work_items` is auto-allowed; every write surfaces a permission prompt.
- **`core/work/`** — the inbox: deterministic scoring (`score.ts`, no LLM in the scoring path), item linking by string-equal refs (`link.ts`), user state (`state.ts`).
- **`core/sources/`** — `github.ts` (via the user's `gh` login) and `slack.ts` (via the claude.ai Slack connector, run as a background headless SDK scan).
- **`core/watch/`** — user-defined ingestion rules; due watches run on a minute-tick due-checker (not cron) as one composed scan.
- **`web/`** — Vite + React + TS SPA → `dist/web`. `src/store.ts` is the client's view of the server as an external store; `src/transcript.ts` is a pure fold of a session's event log into renderable items.

### Persistence & resume

Two core tables: `sessions` (including `sdk_session_id`, captured from the SDK init message) and `session_events` (append-only, `(session_id, seq)`-keyed, stream deltas excluded). The Claude subprocess is ephemeral; a session with no live subprocess is revived on the next user message via the SDK's `resume: sdkSessionId`, which replays Claude Code's own transcript from `~/.claude/projects/…`. Division of labor: **the event log restores the page; `resume` restores the agent.** Nothing in `session_events` is ever fed back to the model. User inbox state lives in its own `item_state` table and survives every snapshot rebuild.

### Rendering the stream

The client store has two notification channels so token deltas don't thrash the UI: **structural** (sessions, connection, committed events — fires once per SDK message) and **live** (the in-flight assistant line — deltas buffered and flushed on `requestAnimationFrame`; only `<LiveLine>` subscribes). `buildTranscript()` is a pure function memoised on the events array.
