---
name: 05-skill-migrator
description: Onboards legacy or unorganized team skills, prompts (.cursorrules, .claude/commands, CLAUDE.md), and helper scripts (.sh, .js, .mjs, .ts, .py) into the <500-token Agentic-SOLID-QE framework and 3-Tier Domain Brain. Invoke /05-skill-migrator [<path> | --discover] to migrate.
file_names:
    - references/migration-starter-guide.md
    - references/legacy-java-csharp-migration-guide.md
---
# Skill 05: Legacy Skill & Test Onboarding Migrator

## 1. Zero-Prompt Auto-Start: Discovery & Dry-Run Scan
When invoked as `/05-skill-migrator`:
1. Read `.agents/domain/domain-memory.md`, `references/migration-starter-guide.md`, and `references/legacy-java-csharp-migration-guide.md`.
2. Scan the workspace for legacy skills/scripts AND Java/C# Selenium + API tests:
   ```bash
   npm run migrate:skill -- --discover
   ```
3. Run the dry-run analyzer on a legacy skill **or** a ranked Wave 1–3 Java/C# test:
   ```bash
   npm run migrate:skill -- <source-path> --name <skill-id> [--squad <squad>]
   npm run migrate:skill -- --legacy <test-id> [--slice <n>] [--static-only]
   ```

## 2. Checkpoint: Present Migration Triage Matrix
Pause and present to the engineer:
1. **Skill/Script Bundle:** `< 500`-token `SKILL.md` + secret-sanitized `references/` & `scripts/` + `≤ 150`-line Domain Shard.
2. **Java/C# Legacy Test Waves:** Wave 1 (small `@smoke`/`@p0` & API), Wave 2 (medium UI), Wave 3 (monoliths split into `api-seeder`, `auth-session`, and atomic UI slices).
3. **Session Tape Bridge:** Draft `.exploratory/tapes/<id>.json` for live `@playwright/cli` verification and `/02-solid-architect` compilation.

## 3. Apply, Verify & Track Parity
Upon engineer confirmation:
1. Re-run with `--apply` (updates `.agents/domain/migration-manifest.json`).
2. Verify live locators via `@playwright/cli` (if UI), compile via `npm run compile:tape`, and run `npm run verify`.
