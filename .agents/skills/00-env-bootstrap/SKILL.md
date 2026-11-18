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
For SSO, MFA, or multi-step login (invoke `/agent-browser` for full CLI command syntax):
1. Launch a headed session via `npx --yes agent-browser --session auth --headed open <baseUrl>`.
2. Execute credential fill from `src/data/user.builder.ts` (or pause for engineer interactive SSO/MFA completion).
3. Persist reusable session state into `.auth/<persona>.json` via `node scripts/export-auth-state.mjs --session auth --out .auth/<persona>.json` (git-ignored) and record cookie/`localStorage` **key names only (never raw token/cookie values)** in `domain-memory.md`.

## 3. Unfamiliar App Navigation & Mandatory Shard Seeding
1. After SPA load, run `npx --yes agent-browser --session auth snapshot -i` (or `snapshot > .agent-browser/page-landing.yml`) and inspect landmarks/links.
2. Scaffold initial shards in `.agents/domain/shards/<feature>.md` (≤ 150 lines; `**Published Capabilities:** *(none yet)*` until compiled), register in `domain-memory.md`, and run `npm run domain:graph`.
3. Close session (`npx --yes agent-browser --session auth close`) and ask which feature to explore next via `01-cli-explorer` (or `00-master-orchestrator`).
