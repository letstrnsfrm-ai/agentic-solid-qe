# AGENTS.md — Universal Agent Instructions (`agentic-solid-qe`)

This repository uses a seven-skill, token-efficient Quality Engineering workflow powered by `@playwright/cli` and `@playwright/test`, led by the **`00-master-orchestrator`** entry point.

## Skill Routing Table

| Task Intent | Skill to Activate | Skill Path |
| :--- | :--- | :--- |
| **Master Entry Point:** Understand all framework skills/features, diagnose repo maturity, recommend an onboarding track, or plan how to incrementally increase automation coverage | `00-master-orchestrator` (`/00-master-orchestrator` or `/master-orchestrator`) | `.agents/skills/00-master-orchestrator/SKILL.md` |
| Bootstrap target URL, capture reusable persona `storageState` auth sessions, or map top-level routes in an unfamiliar app | `00-env-bootstrap` | `.agents/skills/00-env-bootstrap/SKILL.md` |
| Explore a feature, map multi-page flows, run API/state/a11y heuristics, triage defects, or curate Session Tapes | `01-cli-explorer` | `.agents/skills/01-cli-explorer/SKILL.md` |
| Compile Session Tapes into SOLID Playwright TypeScript Components, Pages, Fixtures, Data Builders, and `.spec.ts` files | `02-solid-architect` | `.agents/skills/02-solid-architect/SKILL.md` |
| Diagnose failing `.spec.ts` tests against live deployed environments to separate real regressions from UI/locator drift | `03-drift-healer` | `.agents/skills/03-drift-healer/SKILL.md` |
| Curate `@p0`/`@smoke`/`@regression` tags, harden `playwright.config.ts`, and configure sharded CI/CD pipelines | `04-ci-pipeline` | `.agents/skills/04-ci-pipeline/SKILL.md` |
| Onboard legacy/unorganized team skills, prompts, and helper scripts into `<500`-token `SKILL.md` bundles and 3-Tier Domain Shards | `05-skill-migrator` | `.agents/skills/05-skill-migrator/SKILL.md` |

## AI-Guided Project Installation, Consumer Upgrade & Legacy Skill Migration Protocol

When a user asks how to install, upgrade, or adopt `agentic-solid-qe` in an existing project or migrate their existing skills/prompts/scripts:
1. **Assess & Install or Upgrade Non-Destructively:**
   - **New Adoption:** Run `npx --yes github:letstrnsfrm-ai/agentic-solid-qe init . --url <app-url> --name "<App Name>"` (which merges `package.json` & `tsconfig.json` and preserves any pre-existing `AGENTS.md` or `.github/copilot-instructions.md` in `.agents/legacy-backups/`).
   - **Existing Day-to-Day Consumers Upgrading:** Run `npx --yes github:letstrnsfrm-ai/agentic-solid-qe sync` (`npm run upgrade:skills`) to update skills, `session-tape.schema.json`, and `scripts/*.mjs`, non-destructively seed missing `src/contracts/*` and `src/shared/*` utilities (`overwrite: false`), and merge `@domains/*` and `@shared/*` path aliases into `tsconfig.json` without touching existing domain shards, pages, components, builders, or `.spec.ts` files.
   - **Multi-Squad / Multi-Portal Setup:** Run `npx cortex sync --squad <squad>` (e.g., `motor-b2c`, `home-b2c`, `agent-portal`, `claims`).
2. **Complex Multi-Step Wizards, Cross-Portal Handoffs & Backend APIs:** Read [`.agents/skills/02-solid-architect/references/complex-orchestration-guide.md`](./.agents/skills/02-solid-architect/references/complex-orchestration-guide.md) to classify scenarios into **Pattern A** (`WizardStepContract<TRiskProfile>`), **Pattern B** (`ApiClientContract` + `AuthTokenBridge` API seeding/contract tests), or **Pattern C** (`cross-portal-handoff` multi-actor `BrowserContext`s) and execute **1 test at a time**.
3. **Auto-Discover Legacy Artifacts & SOLID Gaps:** Run `npm run migrate:skill -- --discover` (`npx cortex migrate --discover`) to inventory `.cursorrules`, `.windsurfrules`, `CLAUDE.md`, `.agents/legacy-backups/*`, `.cursor/rules/*`, custom `.claude/commands/*`, `.github/prompts/*`, helper scripts, and non-SOLID `.spec.ts` files.
4. **Dry-Run & Guarded Apply (`/05-skill-migrator`):** For each discovered skill, run `npm run migrate:skill -- <path> --name <skill-id> [--squad <squad>]`, present the **4-Part Migration Triage Matrix**, then run with `--apply` to enforce `<500`-token `SKILL.md` caps, secret redaction in `references/` & `scripts/`, Session Tape bridging (`.exploratory/tapes/<id>.json`) for legacy UI scripts, `≤ 150`-line Domain Shard indexing, and `AGENTS.md` routing registration.
5. **Verify All Guardrails:** Run `npm run verify` (`typecheck` + `domain:graph` + `audit:solid` + `validate:tapes` + `playwright test`).

## Closed-Loop QE Workflow (Orchestrate ➔ Bootstrap ➔ Explore & Curate ➔ Automate 1-Test-at-a-Time ➔ Heal & Run in CI)

0. **Master Orchestrator & Incremental Coverage Advisor (`00-master-orchestrator`):** Entry point (`npx cortex orchestrate` / `/00-master-orchestrator`) that runs live diagnostics (`npm run coverage:gaps` + `npm run migrate:skill -- --discover`), classifies the repository into **Stage 0–4** of the [5-Stage Incremental Coverage Ladder](./.agents/skills/00-master-orchestrator/references/master-orchestration-playbook.md), and recommends the single next action.
1. **Environment & Auth Bootstrap (`00-env-bootstrap`):** Configures `baseUrl`, captures reusable `.auth/<persona>.json` sessions for apps behind SSO/MFA, and seeds top-level feature shards in `.agents/domain/domain-memory.md`.
2. **Feature-Scoped Recon & Multi-Oracle Exploration (`01-cli-explorer`):** Runs `npm run coverage:gaps`, explores unfamiliar multi-page/multi-portal flows and backend APIs via `@playwright/cli --headed`, logs defects to `defects/`, and presents a **Session Debrief & Coverage Selection Matrix** so the QE selects **1 critical scenario at a time** to emit as a Session Tape (`.exploratory/tapes/<scenario>.json`).
3. **Human-Confirmed SOLID Automation (`02-solid-architect`):** Compiles the selected Session Tape 1 test at a time into reusable SOLID Components (`WizardStepContract`), Pages, Backend API Clients (`ApiClientContract` + `AuthTokenBridge`), Fixtures, and Data Builders (`RelativeDateHelper`), and runs `npm run verify`.
4. **Day-2 Drift Healing & CI/CD Readiness (`03-drift-healer` & `04-ci-pipeline`):** Triages live test failures into genuine app defects vs. healed locator drift, tags specs (`@p0`, `@smoke`, `@regression`), and wires sharded CI/CD pipelines.

## Non-Negotiable Repository Guardrails

1. **Always read `.agents/domain/domain-memory.md` first** before opening a browser or generating test code.
2. **Use `@playwright/cli` (`npx playwright-cli -s=<session>`) for exploration and healing** and inspect `.playwright-cli/page-*.yml` disk snapshots instead of streaming raw HTML.
3. **Never place `expect()` inside `src/components/`, `src/pages/`, or `src/domains/**/api/*.client.ts`**. Components, Pages, and API Clients expose action methods, `readonly` semantic `Locator` properties, or typed `ApiResponseEnvelope<T>` responses; web-first assertions (`await expect(...).toBeVisible()`) belong strictly in `tests/*.spec.ts`.
4. **Cap every file in `src/components/` (and `src/domains/**/components/`) at 150 lines** (Single Responsibility Principle).
5. **Never hardcode credentials or magic strings in `tests/*.spec.ts`**; always consume builders from `src/data/` (or `src/domains/<squad>/data/`) and fixtures from `src/fixtures/app.fixture.ts`.
6. **Before completing any code generation or healing task**, run `npm run verify` (`typecheck` + `domain:graph` + `audit:solid` + `validate:tapes` + `playwright test`).
