# AGENTS.md — Universal Agent Instructions (`agentic-solid-qe`)

This repository uses a five-skill, token-efficient Quality Engineering workflow powered by `@playwright/cli` and `@playwright/test`.

## Skill Routing Table

| Task Intent | Skill to Activate | Skill Path |
| :--- | :--- | :--- |
| Bootstrap target URL, capture reusable persona `storageState` auth sessions, or map top-level routes in an unfamiliar app | `00-env-bootstrap` | `.agents/skills/00-env-bootstrap/SKILL.md` |
| Explore a feature, map multi-page flows, run API/state/a11y heuristics, triage defects, or curate Session Tapes | `01-cli-explorer` | `.agents/skills/01-cli-explorer/SKILL.md` |
| Compile Session Tapes into SOLID Playwright TypeScript Components, Pages, Fixtures, Data Builders, and `.spec.ts` files | `02-solid-architect` | `.agents/skills/02-solid-architect/SKILL.md` |
| Diagnose failing `.spec.ts` tests against live deployed environments to separate real regressions from UI/locator drift | `03-drift-healer` | `.agents/skills/03-drift-healer/SKILL.md` |
| Curate `@p0`/`@smoke`/`@regression` tags, harden `playwright.config.ts`, and configure sharded CI/CD pipelines | `04-ci-pipeline` | `.agents/skills/04-ci-pipeline/SKILL.md` |

## Closed-Loop QE Workflow (Bootstrap ➔ Explore & Curate ➔ Automate ➔ Heal & Run in CI)

1. **Environment & Auth Bootstrap (`00-env-bootstrap`):** Configures `baseUrl`, captures reusable `.auth/<persona>.json` sessions for apps behind SSO/MFA, and seeds top-level feature shards in `.agents/domain/domain-memory.md`.
2. **Feature-Scoped Recon & Multi-Oracle Exploration (`01-cli-explorer`):** Runs `npm run coverage:gaps`, explores unfamiliar multi-page flows via `@playwright/cli --headed` while checking API status, console errors, state persistence, and a11y, logs defects to `defects/`, and presents a **Session Debrief & Coverage Selection Matrix** so the QE selects which candidate flows become Session Tapes (`.exploratory/tapes/<scenario>.json`).
3. **Human-Confirmed SOLID Automation (`02-solid-architect`):** Compiles QE-selected Session Tapes into reusable SOLID Components, Pages, Fixtures, and Data Builders with deterministic multi-page synchronization (`waitForUrl`, `waitForNetwork`, `capturedVariables`), and runs `npm run verify`.
4. **Day-2 Drift Healing & CI/CD Readiness (`03-drift-healer` & `04-ci-pipeline`):** Triages live test failures into genuine app defects vs. healed locator drift, tags specs (`@p0`, `@smoke`, `@regression`), and wires sharded CI/CD pipelines.

## Non-Negotiable Repository Guardrails

1. **Always read `.agents/domain/domain-memory.md` first** before opening a browser or generating test code.
2. **Use `@playwright/cli` (`npx playwright-cli -s=<session>`) for exploration and healing** and inspect `.playwright-cli/page-*.yml` disk snapshots instead of streaming raw HTML.
3. **Never place `expect()` inside `src/components/` or `src/pages/`**. Components and Pages expose action methods and `readonly` semantic `Locator` properties; web-first assertions (`await expect(...).toBeVisible()`) belong strictly in `tests/*.spec.ts`.
4. **Cap every file in `src/components/` at 150 lines** (Single Responsibility Principle).
5. **Never hardcode credentials or magic strings in `tests/*.spec.ts`**; always consume builders from `src/data/` and fixtures from `src/fixtures/app.fixture.ts`.
6. **Before completing any code generation or healing task**, run `npm run verify` (`typecheck` + `audit:solid` + `validate:tapes` + `playwright test`).
