# AGENTS.md — Universal Agent Instructions (`agentic-solid-qe`)

Token-efficient QE workflow (`agent-browser`, `cortex`, `@playwright/test`). Entry point: **`agentic-solid-qe`** (`npx cortex orchestrate`).

## Operating Model
- **Human = Director & Reviewer:** States QE goals, approves scenario/triage/PR gates, handles MFA/CAPTCHA. Never ask humans to edit SOLID files, Session Tapes, or run routine CLI/tests.
- **Agent = Autonomous Executor:** Route all commands & questions via `npx cortex orchestrate` (`--loop --compact`, `GATE_OPTIONS`). Pause only at human gates.

## Skill Router (`.agents/skills/<id>/SKILL.md`)
- `agentic-solid-qe`: Single entry point (`--loop`, `--bootstrap`, `--explore`, `--tape`, `--heal-action`, `--ci-init`, `--context`, `--verify`).
- `00-env-bootstrap`: `baseUrl`, `.auth/<persona>.json`, route shards (`--bootstrap --discover-shards`).
- `01-cli-explorer`: Live recon, oracles, defects, Session Tapes (`--explore`).
- `02-solid-architect`: Compile 1 Session Tape ➔ SOLID TS + `verify:fast` (`--loop`).
- `03-drift-healer`: Live failure triage (bug ➔ `defects/` vs. `--heal-action apply`).
- `04-ci-pipeline`: `@p0`/`@smoke`/`@regression` tags & sharded CI (`--ci-init`).
- `05-skill-migrator`: Legacy prompts, scripts, Java/C# suites & waves.
- `agent-browser`: Compact live browser CLI syntax.

## Non-Negotiable Guardrails
1. **Context Packs first:** Run `npx cortex orchestrate --context [--route|--squad|--tape|--spec]` (`≤ 400` tok) before raw reads. Use `orchestrate --tape show|clone|patch` instead of raw tape JSON.
2. **Lazy References:** Open `references/*.md` (`≤ 800` tok) *only* for the active topic. Onboarding/upgrade: `agentic-solid-qe/references/onboarding-and-upgrade.md`.
3. **Compact Loop:** Use `cortex orchestrate --loop --compact`, `orchestrate --explore`, `orchestrate --verify --fast`, `orchestrate --verify`.
4. **SOLID `src/`:** Zero `expect()` in `components/`, `pages/`, `api/`, `seeders/`. Components/steps/seeders `≤ 150`L.
5. **Specs (`tests/*.spec.ts`):** Consume `src/data/*.builder.ts` + `src/fixtures/app.fixture.ts`; use business-domain `test.step()`.
6. **Budgets:** `audit:solid` enforces `AGENTS.md ≤ 600`, `copilot-instructions.md ≤ 600`, `SKILL.md ≤ 500`, `references/*.md ≤ 800`, zero orphans.

