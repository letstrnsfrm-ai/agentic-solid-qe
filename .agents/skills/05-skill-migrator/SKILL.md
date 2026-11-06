---
name: 05-skill-migrator
description: Onboards legacy or unorganized team skills, prompts (.cursorrules, .claude/commands), and helper scripts (.sh, .js, .mjs, .ts, .py) into the <500-token Agentic-SOLID-QE framework and 3-Tier Domain Brain. Invoke /05-skill-migrator <path> to migrate.
---

# Skill 05: Legacy Skill & Script Onboarding Migrator

## 1. Zero-Prompt Auto-Start: Dry-Run Scan
When invoked as `/05-skill-migrator <source-path>`:
1. Read `.agents/domain/domain-memory.md` and `references/migration-starter-guide.md`.
2. Run the analyzer in dry-run mode:
   ```bash
   npm run migrate:skill -- <source-path> --name <skill-id> [--squad <squad>]
   ```
3. Inspect the JSON **Migration Triage Report** for:
   - **Token Budget:** `originalTokens` vs. `< 500` limit and extracted `references/legacy-reference.md`.
   - **Script Roles:** `utility-or-api-seeder` (co-locate in `scripts/`) vs. `legacy-ui-automation` (bridge to `.exploratory/tapes/<scenario>.json`).
   - **Domain Facts:** Routes, API rules, and `data-testid` attributes for `.agents/domain/`.

## 2. Checkpoint: Present 4-Part Migration Triage Matrix
Pause and present to the engineer:
1. **Normalized Skill Bundle:** Target `.agents/skills/<skill-id>/SKILL.md` (< 500 tokens) + `references/legacy-reference.md`.
2. **Script Relocation & Sanitization:** Rewritten root-relative commands (`node .agents/skills/<skill-id>/scripts/<file>`) and `process.env.BASE_URL` / secret parameterization.
3. **UI Script ➔ Session Tape Bridge:** Legacy Puppeteer/Playwright UI scripts flagged for `/02-solid-architect` compilation.
4. **Domain Shard Extraction:** Candidate invariants and precondition seeders for `.agents/domain/`.

## 3. Apply, Wire Wrappers & Verify
Upon engineer confirmation:
1. Run `npm run migrate:skill -- <source-path> --name <skill-id> [--squad <squad>] --apply`.
2. Refine `SKILL.md`, register in `AGENTS.md`, and append domain rules to the target shard.
3. Run `npm run verify`.
