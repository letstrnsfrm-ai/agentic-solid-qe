---
name: playwright-cli
description: Token-efficient @playwright/cli command reference for live browser automation, snapshots, attaching to paused tests (--debug=cli / --cdp), network mocking, and state persistence. Invoke /playwright-cli or read this skill before running npx playwright-cli commands.
---

# Skill: `@playwright/cli` Command Reference

Use `npx playwright-cli -s=<session>` to drive live browsers via compact YAML snapshots (`.playwright-cli/page-*.yml`) without `--help` round trips. Detailed flags live in `references/commands-reference.md`.

## 1. Session Lifecycle & Attach
- `open [url] [--headed] [--browser=chromium]` — Launch browser.
- `attach [--cdp=http://localhost:9222 | --cdp=chrome | --extension]` — Attach to running browser / paused test.
- `detach` / `close` / `close-all` — Detach or close sessions.

## 2. Snapshot & Interaction (`e<N>` refs from `.playwright-cli/page-*.yml`)
- `snapshot [--filename=...]` / `find "<text>"` — ARIA tree & search (re-snapshot after Shadow DOM/dynamic re-renders; `e<N>` refs invalidate).
- `click` / `dblclick` / `hover` / `press <key>` — Pointer & keyboard.
- `fill <ref> <text>` / `type <text>` / `select` / `check` / `uncheck` / `upload` — Forms.
- `goto <url>` / `go-back` / `go-forward` / `reload` — Navigation.

## 3. Inspection, Recording & State
- `eval "<js-fn>"` / `console [error]` / `requests` / `request <idx>` — Telemetry & network inspection.
- `route <url> [--status=500]` / `unroute` — Network mocking.
- `state-save <file>` / `state-load <file>` — Auth persistence.
- `screenshot` / `tracing-start` / `tracing-stop` — Evidence.
- `recording-start` / `recording-stop` — Record Playwright codegen.
- `pause-at <file:line>` / `resume` / `step-over` — Pause/step tests.
- `tab-list` / `tab-new [url]` / `tab-select <idx>` / `tab-close` — Tabs.
