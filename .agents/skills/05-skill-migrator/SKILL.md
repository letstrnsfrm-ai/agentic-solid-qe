---
name: 05-skill-migrator
description: Onboards legacy or unorganized team skills, prompts (.cursorrules, .claude/commands, CLAUDE.md), and helper scripts (.sh, .js, .mjs, .ts, .py) into the <500-token Agentic-SOLID-QE framework and 3-Tier Domain Brain. Invoke /05-skill-migrator [<path> | --discover] to migrate.
file_names:
    - references/migration-starter-guide.md
---
# Skill 05: Legacy Skill & Script Onboarding Migrator

## 1. Zero-Prompt Auto-Start: Discovery & Dry-Run Scan
When invoked as `/05-skill-migrator`:
1. Read `.agents/domain/domain-memory.md` and `references/migration-starter-guide.md`.
2. If no `<source-path>` is given, scan the workspace for legacy rules/skills and non-SOLID specs:
   ```bash
   npm run migrate:skill -- --discover
   ```
3. Run the dry-run analyzer on each target skill or prompt:
   ```bash
   npm run migrate:skill -- <source-path> --name <skill-id> [--squad <squad>]
   ```

## 2. Checkpoint: Present 4-Part Migration Triage Matrix
Pause and present to the engineer:
1. **Normalized Skill Bundle:** Target `.agents/skills/<skill-id>/SKILL.md` (`< 500` tokens) + secret-sanitized `references/legacy-reference.md`.
2. **Script Relocation:** `utility-or-api-seeder` scripts moved to `.agents/skills/<skill-id>/scripts/` with `process.env.BASE_URL` and secret redaction.
3. **UI Script ➔ Session Tape Bridge:** `legacy-ui-automation` scripts archived in `references/` and bridged into `.exploratory/tapes/<skill-id>.json` for `/02-solid-architect`.
4. **Domain Shard & Routing:** Candidate `≤ 150`-line shard in `.agents/domain/` + `AGENTS.md` routing entry.

## 3. Apply, Wire Wrappers & Verify
Upon engineer confirmation:
1. Run `npm run migrate:skill -- <source-path> --name <skill-id> [--squad <squad>] --apply`.
2. Refine extracted domain rules in the target shard (`≤ 150` lines).
3. Run `npm run verify`.
