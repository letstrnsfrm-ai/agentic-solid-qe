---
name: playwright-cli
description: Token-efficient @playwright/cli command reference for live browser automation, snapshots, attaching to paused tests (--debug=cli / --cdp), network mocking, and state persistence. Invoke /playwright-cli or read this skill before running npx playwright-cli commands.
---

# Skill: `@playwright/cli` Command Reference

Use `npx playwright-cli -s=<session>` to drive live browsers via compact YAML snapshots (`.playwright-cli/page-*.yml`) without `--help` round trips. Detailed flags live in `references/commands-reference.md`.

## 1. Session Lifecycle & Attach
- `open [url] [--headed] [--browser=chromium]` — Launch browser session.
- `attach [--cdp=http://localhost:9222 | --cdp=chrome | --extension]` — Attach to a running browser or paused `--debug=cli` / `npm run test:explore` test.
- `detach` — Detach without closing the external browser.
- `close` / `close-all` — Close session(s).

## 2. Snapshot & Element Interaction (`e<N>` refs from `.playwright-cli/page-*.yml`)
- `snapshot [--filename=.playwright-cli/page-step.yml]` — Capture ARIA tree & refs.
- `click <ref>` / `dblclick <ref>` / `hover <ref>` — Pointer actions.
- `fill <ref> <text>` / `type <text>` / `press <key>` — Text & keyboard input.
- `select <ref> <value>` / `check <ref>` / `uncheck <ref>` / `upload <ref> <path>` — Form controls.
- `goto <url>` / `go-back` / `go-forward` / `reload` — Navigation.

## 3. Inspection, State & Network
- `eval "<js-fn>"` — Run JS in page (e.g. `"() => location.href"`).
- `console [error|warning]` / `network` — Read console & HTTP telemetry.
- `route <url-pattern> [--status=500] [--body=...]` / `unroute` — Mock/fault-inject APIs.
- `state-save <file>` / `state-load <file>` — Persist/restore `.auth/<persona>.json`.
- `screenshot [ref] [--filename=...]` / `tracing-start` / `tracing-stop` — Evidence capture.
- `tab-list` / `tab-new [url]` / `tab-select <index>` / `tab-close [index]` — Multi-tab control.
