---
name: 03-drift-healer
description: Diagnoses failing Playwright .spec.ts tests against live deployed environments via @playwright/cli to separate genuine application regressions from UI/locator/flow drift. Invoke /03-drift-healer when CI or local specs fail.
---

# Skill 03: Live Drift Healer & Failure Triage

## 1. Zero-Prompt Auto-Start: Failure Isolation
When invoked as `/03-drift-healer`, immediately execute:
1. Run `npx playwright test` (or the target failing `.spec.ts`) and read `.agents/domain/domain-memory.md`.
2. Extract the failing `scenarioId`, step, locator, and error stack trace, then cross-reference `.exploratory/tapes/<scenarioId>.json` and `.agents/domain/shards/<feature>.md`.

## 2. Live `@playwright/cli` Differential Inspection (`references/healing-playbook.md`)
1. Open the target environment in headed mode:
   ```bash
   npx playwright-cli -s=heal open <baseUrl> --headed
   ```
2. Replay steps up to the failure point and inspect `.playwright-cli/page-*.yml` + `npx playwright-cli -s=heal console error`.
3. Compare the live accessibility snapshot and API responses against the recorded Session Tape.

## 3. Root-Cause Classification & Action (Checkpoint)
Present the diagnosis to the engineer:
- **Case A — Genuine Application Regression:** Do **not** weaken or delete the test assertion. Capture `playwright-cli screenshot`, log `defects/DEFECT-<timestamp>.md`, and annotate the spec with `test.fixme()` / `test.fail()` referencing the defect ID.
- **Case B — Harmless UI / Locator / Flow Drift:** Upon engineer confirmation, update `.exploratory/tapes/<scenarioId>.json`, heal the locator in `src/components/` or `src/pages/`, update `.agents/domain/shards/<feature>.md`, and run `npm run verify`.
