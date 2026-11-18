---
name: 00-env-bootstrap
description: Guided environment onboarding, persona authentication (storageState persistence), and top-level navigation discovery for unfamiliar deployed web applications. Invoke /00-env-bootstrap before exploring a new target app or environment.
---

# Skill 00: Environment, Auth & App Map Bootstrap

## 1. Zero-Prompt Auto-Start: Environment Audit
When invoked as `/00-env-bootstrap`, immediately execute:
1. Run `npm run coverage:gaps` and read `.agents/domain/domain-memory.md`.
2. If `needsTargetUrlConfig` is true (or the engineer provides a new URL/app name), run:
   ```bash
   npm run init:app -- --url <targetUrl> --name "<App Name>"
   ```

## 2. Persona Auth & `storageState` Bootstrap (`references/auth-and-discovery.md`)
For SSO, MFA, or multi-step login (invoke `/playwright-cli` for full CLI command syntax):
1. Launch a headed session via `npx playwright-cli -s=auth open <baseUrl> --headed` (add `--browser=chromium` if default `chrome` is unavailable).
2. Execute credential fill from `src/data/user.builder.ts` (or pause for engineer interactive SSO/MFA completion).
3. Persist reusable session state into `.auth/<persona>.json` (git-ignored) and record cookie/`localStorage` **key names only (never raw token/cookie values)** in `domain-memory.md`. Reopen idle sessions via `.playwright/cli.config.json` (`browser.contextOptions.storageState`).

## 3. Unfamiliar App Navigation & Mandatory Shard Seeding
1. After SPA load, run `npx playwright-cli -s=auth snapshot --filename=.playwright-cli/page-landing.yml` and inspect landmarks/links.
2. Scaffold initial shards in `.agents/domain/shards/<feature>.md` (≤ 150 lines; `**Published Capabilities:** *(none yet)*` until compiled), register in `domain-memory.md`, and run `npm run domain:graph`.
3. Close session (`npx playwright-cli -s=auth close`) and ask which feature to explore next via `01-cli-explorer` (or `00-master-orchestrator`).
