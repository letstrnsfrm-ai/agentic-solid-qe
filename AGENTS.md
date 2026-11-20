# AGENTS.md — Universal Agent Instructions (`agentic-solid-qe`)

Token-efficient QE workflow (`agent-browser`, `cortex`, `@playwright/test`). Entry point: **`00-master-orchestrator`**.

## Operating Model
- **Human = Director & Reviewer:** States QE goals, approves scenario/triage/PR gates, handles MFA/CAPTCHA. Never ask humans to edit SOLID files, Session Tapes, or run routine CLI/tests.
- **Agent = Autonomous Executor:** Start with `npx cortex orchestrate --loop --compact`, execute end-to-end, pause only at human gates.

## Skill Router (`.agents/skills/<id>/SKILL.md`)
- `00-master-orchestrator`: Default entry point (all QE goals, coverage, install/upgrade).
- `00-env-bootstrap`: `baseUrl`, `.auth/<persona>.json`, route shards.
- `01-cli-explorer`: Live recon, oracles, defects, Session Tapes.
- `02-solid-architect`: Compile 1 Session Tape ➔ SOLID TS + `verify:fast`.
- `03-drift-healer`: Live failure triage (bug ➔ `defects/` vs. healed drift).
- `04-ci-pipeline`: `@p0`/`@smoke`/`@regression` tags & sharded CI.
- `05-skill-migrator`: Legacy prompts, scripts, Java/C# suites & waves.
- `agent-browser`: Compact live browser CLI syntax.

## Non-Negotiable Guardrails
1. **Context Packs first:** Run `npx cortex context [--route|--squad|--tape|--spec]` (`≤ 400` tok) before raw reads. Use `npx cortex tape show|clone|patch` instead of raw tape JSON.
2. **Lazy References:** Open `references/*.md` (`≤ 800` tok) *only* for the active topic. Onboarding/upgrade: `00-master-orchestrator/references/onboarding-and-upgrade.md`.
3. **Compact Loop:** Use `cortex orchestrate --loop --compact`, `cortex explore`, `npm run verify:fast` (inner loop), `npm run verify` (final gate).
4. **SOLID `src/`:** Zero `expect()` in `components/`, `pages/`, `api/`, `seeders/`. Components/steps/seeders `≤ 150`L.
5. **Specs (`tests/*.spec.ts`):** Consume `src/data/*.builder.ts` + `src/fixtures/app.fixture.ts`; use business-domain `test.step()`.
6. **Budgets:** `audit:solid` enforces `AGENTS.md ≤ 600`, `copilot-instructions.md ≤ 600`, `SKILL.md ≤ 500`, `references/*.md ≤ 800`, zero orphans. Overrides: `references/local-overrides.md`.
