---
name: 05-skill-migrator
description: Onboards legacy or unorganized team skills, prompts (.cursorrules, .claude/commands, CLAUDE.md), helper scripts, and Java/C# test suites into the <500-token Agentic-SOLID-QE framework and 3-Tier Domain Brain.
---

# Skill 05: Legacy Skill & Test Onboarding Migrator

## 1. Zero-Prompt Auto-Start: Discovery & Dry-Run
1. Run `npx cortex context` (`≤ 400` tok) and scan the workspace:
   ```bash
   npm run migrate:skill -- --discover
   ```
2. Run dry-run analysis on 1 legacy skill **or** a ranked Wave 1–3 Java/C# test:
   ```bash
   npm run migrate:skill -- <source-path> --name <skill-id> [--squad <squad>]
   npm run migrate:skill -- --legacy <test-id> [--slice <n>] [--static-only]
   ```
   For large suites (50–2,000 tests), use `npx cortex wave --scan <legacy-dir>` + `npx cortex wave --run --verify --workers 4`.

## 2. Human Checkpoint: 4-Part Triage Matrix
Pause and present:
1. **Skill/Script Bundle:** `< 500`-tok `SKILL.md`, `≤ 800`-tok sanitized `references/` & `scripts/`, `≤ 150`-line Domain Shard.
2. **Java/C# Legacy Waves:** Wave 0 (Seeders/Flows), Wave 1 (`@p0`/API), Wave 2 (medium UI), Wave 3 (split monoliths).
3. **Session Tape Bridge:** Draft `.exploratory/tapes/<id>.json` for live verification & `/02-solid-architect`.

## 3. Apply & Verify
Re-run with `--apply`, compile via `02-solid-architect` (or `cortex wave --run --verify`), and run `npm run verify`.

## 4. Lazy Reference Index (Read ONLY When Needed)
- `references/migration-starter-guide.md` — Target skill anatomy & Phase A–D onboarding workflow.
- `references/migration-guardrails-checklist.md` — 4-Part Triage Matrix, guardrail mapping & Wave Factory (`cortex wave`).
- `references/legacy-java-csharp-migration-guide.md` — Java/C# Selenium/RestAssured/SpecFlow migration rules.
