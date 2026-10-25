# AGENTS.md — Universal Agent Instructions (`agentic-solid-qe`)

This repository uses a two-stage, token-efficient Quality Engineering workflow powered by `@playwright/cli` and `@playwright/test`.

## Skill Routing Table

| Task Intent | Skill to Activate | Skill Path |
| :--- | :--- | :--- |
| Explore a feature, run heuristics, triage bugs, update `domain-memory.md`, or record a Session Tape | `01-cli-explorer` | `.agents/skills/01-cli-explorer/SKILL.md` |
| Generate, refactor, or heal Playwright TypeScript Components, Pages, Fixtures, Data Builders, or `.spec.ts` files | `02-solid-architect` | `.agents/skills/02-solid-architect/SKILL.md` |

## Closed-Loop QE Workflow (Explore ➔ Confirm ➔ Automate)

1. **Gap Analysis & Risk Recommendation (`01-cli-explorer`):** Runs `npm run coverage:gaps`, inspects `domain-memory.md` + live app routes via `@playwright/cli --headed`, and recommends the **Top 3 Uncovered Golden Path / High-Risk Scenarios** to the engineer.
2. **Human-Confirmed Exploration (`01-cli-explorer`):** Executes the engineer-approved charter in `--headed` mode, logs defects to `defects/`, updates `.agents/domain/shards/<feature>.md`, and emits a validated `.exploratory/tapes/<scenario>.json`.
3. **Human-Confirmed SOLID Automation (`02-solid-architect`):** Once the engineer confirms automating the recorded Session Tape, `02-solid-architect` scaffolds/reuses SOLID Components, Pages, Fixtures, and Data Builders, and runs `npm run verify`.

## Non-Negotiable Repository Guardrails

1. **Always read `.agents/domain/domain-memory.md` first** before opening a browser or generating test code.
2. **Use `@playwright/cli` (`npx playwright-cli -s=<session>`) for exploration** and inspect `.playwright-cli/page-*.yml` disk snapshots instead of streaming raw HTML.
3. **Never place `expect()` inside `src/components/` or `src/pages/`**. Components and Pages expose action methods and `readonly` semantic `Locator` properties; web-first assertions (`await expect(...).toBeVisible()`) belong strictly in `tests/*.spec.ts`.
4. **Cap every file in `src/components/` at 150 lines** (Single Responsibility Principle).
5. **Never hardcode credentials or magic strings in `tests/*.spec.ts`**; always consume builders from `src/data/` and fixtures from `src/fixtures/app.fixture.ts`.
6. **Before completing any code generation task**, run `npm run verify` (`typecheck` + `audit:solid` + `validate:tapes` + `playwright test`).
