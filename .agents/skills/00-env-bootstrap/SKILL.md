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
For complex deployed apps behind SSO, MFA, or multi-step login:
1. Launch a headed session via `npx playwright-cli -s=auth open <baseUrl> --headed`.
2. Execute credential fill from `src/data/user.builder.ts` (or pause for engineer interactive SSO/MFA completion).
3. Persist reusable session state into `.auth/<persona>.json` (git-ignored) and record cookie/`localStorage` session keys in `.agents/domain/domain-memory.md`.

## 3. Unfamiliar App Navigation & Shard Seeding
1. Inspect `.playwright-cli/page-*.yml` landmarks (`navigation`, `banner`, `main`, menu links) across the landing view.
2. Scaffold initial feature shards in `.agents/domain/shards/<feature>.md` (≤ 150 lines) and register them in `domain-memory.md`.
3. Close the session (`npx playwright-cli -s=auth close`) and ask the engineer which discovered feature to explore via `/01-cli-explorer`.
