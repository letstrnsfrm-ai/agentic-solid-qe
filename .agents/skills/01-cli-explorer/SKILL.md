---
name: 01-cli-explorer
description: Autonomous feature discovery, multi-page exploratory testing, API/state/a11y observation triage, and interactive coverage curation via @playwright/cli.
---

# Skill 01: CLI Explorer, Feature Recon & Coverage Curator

## 1. Zero-Prompt Auto-Start: Feature Recon & Gap Analysis (FR-1.1)
When invoked as `/01-cli-explorer`:
1. Run `npm run coverage:gaps` and read `.agents/domain/domain-memory.md` (+ `.agents/domain/shards/*.md`).
2. Open `--headed` recon (`npx playwright-cli -s=explore open <baseUrl> --headed`) and map unfamiliar multi-page routes via `.playwright-cli/page-*.yml`.
3. **Checkpoint 1:** If no feature was specified, present the **Top 3 Uncovered High-Risk Scenarios** (P0 ➔ P1 ➔ P2 per `references/charters.md`) and ask which to explore.

## 2. Multi-Page Exploration & Quality Oracles (FR-1.2, FR-1.3)
Traverse the feature flow while executing multi-oracle checks (`references/charters.md`):
- **Locator Contract:** Map `.playwright-cli/page-*.yml` refs (`e14`) to `parentScope` + `filterTextRef` + `getByRole`/`getByLabel`/`getByPlaceholder`/`getByTestId`.
- **API, Console & State Telemetry:** Check `npx playwright-cli -s=explore console error`, 4xx/5xx API transitions, cross-page state persistence, and boundary inputs.

## 3. Defect Triage & Sharded Memory (FR-1.4, FR-2.1)
- **Defects:** Run `playwright-cli screenshot` and log `defects/DEFECT-<timestamp>.md` (`references/defect-template.md`).
- **Shards:** Append routes, API rules, and quirks to `.agents/domain/shards/<feature>.md` (≤ 150 lines).

## 4. Session Debrief & Coverage Selection Matrix (FR-1.5)
1. **Checkpoint 2:** Present the **Session Debrief & Candidate Regression Matrix** (`references/charters.md`: Flow Map, Defects/Observations, Ranked P0–P2 Candidates).
2. Emit validated `.exploratory/tapes/<scenario-id>.json` (`npm run validate:tapes`) for QE-selected flows and hand off to `/02-solid-architect`.
