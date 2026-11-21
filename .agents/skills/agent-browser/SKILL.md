---
name: agent-browser
description: High-speed Rust-backed CLI reference for live browser automation, interactive-only snapshots (-i), CDP attach (--cdp 9222), network mocking, built-in axe-core a11y, and auth export. Invoke /agent-browser or read this skill before running npx agent-browser commands.
---

# Skill: `agent-browser` Command Reference

Use `npx agent-browser --session <name>` for daemon-backed browser automation and token-lean snapshots (`-i`). Full flags: `references/commands-reference.md`.

## 1. Session Lifecycle & CDP Attach
- `[--headed] open <url>` — Launch browser (`--headed` before `open` for visible UI) & navigate.
- `--cdp <port|url>` / `connect <port|url>` — Attach to running browser / paused `npm run test:explore` (`9222`).
- `close [--all]` — Close current or all sessions.

## 2. Snapshot & Interaction (`@e<N>` refs from `snapshot -i`)
- `snapshot [-i] [--json]` — ARIA tree (`-i` interactive only; re-snapshot after Shadow DOM/dynamic re-renders as `@e<N>` refs invalidate).
- `click <@ref|sel>` / `dblclick` / `hover` / `press <key>` — Pointer & keyboard.
- `fill <@ref|sel> <text>` / `type` / `select <@ref> <val>` / `check` / `uncheck` / `upload` — Forms.
- `find role <role> <action> --name <n>` / `find <text|label|testid> <val> <action>` — Semantic locators.
- `back` / `forward` / `reload` — Navigation.

## 3. Inspection, Telemetry, A11y & State
- `eval "<js>"` / `console` / `errors` — JS & console/page errors.
- `network requests [--filter <pat>]` / `network route <url> [--abort|--body <json>]` / `network unroute` — Network inspection & mocking.
- `a11y [--json]` / `vitals [--json]` — Built-in `axe-core` WCAG audit & Core Web Vitals.
- `screenshot [path] [--full] [--annotate]` / `diff snapshot` / `trace start|stop` — Evidence & diffs.
- `node scripts/export-auth-state.mjs --session <name> --out .auth/<persona>.json` — Export Playwright `storageState`.
- `tab [new|list|close|<n>]` — Tabs.
