# AGENTS.md — Universal Agent Instructions (`agentic-solid-qe`)

Token-efficient QE workflow (`agent-browser`, `cortex`, `@playwright/test`). Entry point: **`agentic-solid-qe`** (`npx cortex orchestrate`).

## Operating Model
- **Human = Director & Reviewer:** States goals, approves scenario/triage/PR gates, handles MFA/CAPTCHA. Never ask humans to edit SOLID files, Tapes, or run routine CLI/tests.
- **Agent = Autonomous Executor:** Route commands & questions via `npx cortex orchestrate` (`--loop --compact`, `GATE_OPTIONS`). Pause only at gates.

## Skill Router (`.agents/skills/<id>/SKILL.md`)
- `agentic-solid-qe`: Entry point (`--loop`, `--autonomous`, `--bootstrap`, `--explore`, `--tape`, `--heal-action`, `--ci-init`, `--context`, `--verify`).
- `00-env-bootstrap`: `baseUrl`, `.auth/<persona>.json`, route shards (`--bootstrap --discover-shards`).
- `01-cli-explorer`: Live recon, oracles, defects, Session Tapes (`--explore`).
- `02-solid-architect`: Compile Tape ➔ SOLID TS + `verify:fast` (`--loop`).
- `03-drift-healer`: Live triage (bug ➔ `defects/` vs. `--heal-action apply`).
- `04-ci-pipeline`: `@p0`/`@smoke`/`@regression` tags & sharded CI (`--ci-init`).
- `05-skill-migrator`: Legacy prompts, scripts, Java/C# suites & waves.
- `agent-browser`: Compact live browser CLI syntax.

## Non-Negotiable Guardrails
1. **Context Packs first:** Run `npx cortex orchestrate --context [--route|--squad|--tape|--spec|--skill]` (`≤ 400` tok) before raw reads; use `--tape show|clone|patch`.
2. **Lazy References:** Open `references/*.md` (`≤ 800` tok) *only* for the active topic. Onboarding: `agentic-solid-qe/references/onboarding-and-upgrade.md`.
3. **Compact Loop:** Use `cortex orchestrate --loop --compact`, `--explore`, `--verify --fast`, `--verify`.
4. **SOLID `src/` & Specs:** Zero `expect()` in `components/`, `pages/`, `api/`, `seeders/` (`≤ 150`L). Specs use `src/data/*.builder.ts` + `app.fixture.ts` + `test.step()`.
5. **Write-Routing:** Never edit core `SKILL.md` for app/team rules; route app quirks ➔ `.agents/domain/` shards and team policies ➔ `.agents/overrides/<topic>.md` (`**Scope:**`, `≤ 800` tok; split, never summarize).
6. **Budgets:** `audit:solid` enforces `AGENTS.md`/`copilot-instructions.md ≤ 600`, `SKILL.md ≤ 500`, `references/` & `overrides/ ≤ 800`, zero orphans.

