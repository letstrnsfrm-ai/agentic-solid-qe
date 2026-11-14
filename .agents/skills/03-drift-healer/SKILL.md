---
name: 03-drift-healer
description: Diagnoses failing Playwright .spec.ts tests against live deployed environments via @playwright/cli to separate genuine application regressions from UI, wizard, API contract, or auth session drift. Invoke /03-drift-healer when CI or local specs fail.
---

# Skill 03: Live Drift Healer & Failure Triage

## 1. Zero-Prompt Auto-Start: Failure Isolation
When invoked as `/03-drift-healer`:
1. Run `npx playwright test` (or target `.spec.ts`) and read `.agents/domain/domain-memory.md`.
2. Extract failing `scenarioId`, actor/portal, step, locator/endpoint, and stack trace, then cross-reference `.exploratory/tapes/<scenarioId>.json` and Domain Shards.

## 2. Live `@playwright/cli` & API Differential Inspection (`references/healing-playbook.md`)
1. Open the target portal: `npx playwright-cli -s=heal open <baseUrl> --headed`. Reopen sessions via `.playwright/cli.config.json` (`storageState`).
2. Replay to failure, run `snapshot --filename=.playwright-cli/page-heal.yml`, check `eval "() => location.href"`, and run `console error`.
3. Compare live UI, conditional wizard steps, `.auth/<persona>.json` validity, and backend API responses against the Session Tape.

## 3. 7-Way Root-Cause Classification & Action (`references/healing-playbook.md`)
Present the diagnosis to the engineer:
- **Case A — Genuine App Regression / Business Logic Defect:** Never weaken assertions. Capture `playwright-cli screenshot`, log `defects/DEFECT-<timestamp>.md`, and annotate with `test.fixme()` / `test.fail()`.
- **Case B — Expired `.auth/<persona>.json` Session (`401/403`):** Re-capture persona auth via `/00-env-bootstrap` before modifying code.
- **Case C — UI Locator, Conditional Wizard (`WizardStepContract`), Backend API Seeder (`ApiClientContract`), or 3rd-Party Sandbox Drift:** Upon confirmation, heal `.exploratory/tapes/<scenarioId>.json`, `src/`, and Domain Shards, then run `npm run verify`.
