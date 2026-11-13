---
name: 01-cli-explorer
description: Autonomous feature discovery, multi-page exploratory testing, API/state/a11y observation triage, and interactive coverage curation via @playwright/cli.
---

# Skill 01: CLI Explorer, Feature Recon & Coverage Curator

## 1. Zero-Prompt Auto-Start: Feature Recon & Gap Analysis (FR-1.1)
When invoked as `/01-cli-explorer`:
1. Run `npm run coverage:gaps` and read `.agents/domain/domain-memory.md` (+ `shards/*.md`).
2. Open `--headed` recon (`npx playwright-cli -s=explore open <baseUrl> --headed`, or `--browser=chromium`). Reopen idle sessions via `.playwright/cli.config.json` (`storageState`).
3. **Checkpoint 1:** If no feature was specified, present the **Top 3 Uncovered High-Risk Scenarios** (`references/charters.md`) and ask which to explore.

## 2. Multi-Page Exploration & Quality Oracles (FR-1.2, FR-1.3)
Traverse the feature flow with multi-oracle checks (`references/charters.md`):
- **SPA Snapshot & URL Truth:** After SPA nav, run `snapshot --filename=.playwright-cli/page-step.yml` and `eval "() => location.href"` for `waitForUrl`.
- **Locator Contract:** Map YAML refs (`e14`) to `parentScope` + `filterTextRef` + `getByRole`/`getByLabel`/`getByPlaceholder`/`getByTestId`.
- **API & Console Telemetry:** Run `console error` and check API status; separate expected negative-flow `4xx` (e.g. `401`) from unexpected `5xx`/errors.

## 3. Defect Triage & Sharded Memory (FR-1.4, FR-2.1)
- **Defects:** Run `playwright-cli screenshot` and log `defects/DEFECT-<timestamp>.md` (`references/defect-template.md`).
- **Shards:** Append routes, `apiBaseUrl`, and quirks to `.agents/domain/shards/<feature>.md` (≤ 150 lines).

## 4. Session Debrief & Coverage Matrix (FR-1.5)
1. **Checkpoint 2:** Present the **Session Debrief & Candidate Regression Matrix** (`references/charters.md`).
2. Emit `.exploratory/tapes/<scenario-id>.json` (`npm run validate:tapes`), run `npm run domain:graph -- --seed-from-tapes`, and hand off to `/02-solid-architect`.
