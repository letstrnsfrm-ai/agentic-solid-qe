---
name: 01-cli-explorer
description: Exploratory testing, coverage gap analysis, and defect triage via @playwright/cli. Invoke /01-cli-explorer to auto-analyze gaps, recommend Golden Path charters, run headed sessions, log defects, emit Session Tapes, and hand off to 02-solid-architect.
---

# Skill 01: CLI Explorer & Risk-Based Triage

## 1. Zero-Prompt Auto-Start: Gap Analysis (FR-1.1)
When invoked as `/01-cli-explorer`, immediately execute:
1. Run `npm run coverage:gaps` and read `.agents/domain/domain-memory.md` (+ `.agents/domain/shards/*.md`).
2. Open `--headed` recon (`npx playwright-cli -s=explore open <baseUrl> --headed`) and compare `.playwright-cli/page-*.yml` routes against `tests/*.spec.ts`.
3. **Checkpoint 1:** Present the **Top 3 Uncovered High-Risk Scenarios** (P0 ➔ P1 ➔ P2 per `references/charters.md`) and ask which number (`1`, `2`, or `3`) to run.

## 2. Headed CLI Execution & Ref Translation (FR-1.2, FR-1.3)
Run the confirmed charter:
```bash
npx playwright-cli -s=explore fill <ref> "<value>"
npx playwright-cli -s=explore click <ref>
npx playwright-cli -s=explore console error
npx playwright-cli -s=explore close
```
Inspect only `.playwright-cli/page-*.yml` snapshots. Map CLI refs (`e14`) into a **Hierarchical Locator Contract** (`parentScope` + `getByRole`/`getByLabel`/`getByPlaceholder`/`getByTestId`).

## 3. Defect Triage & Sharded Memory (FR-1.4, FR-2.1)
- **Defects:** Run `playwright-cli screenshot` and log `defects/DEFECT-<timestamp>.md` (`references/defect-template.md`).
- **Sharded Memory:** Append quirks to `.agents/domain/shards/<feature>.md` (≤ 150 lines; split and index in `domain-memory.md` if > 120 lines).

## 4. Session Tape & Architect Handoff (FR-1.5)
1. Save verified flows to `.exploratory/tapes/<scenario-id>.json` and run `npm run validate:tapes`.
2. **Checkpoint 2:** Ask the engineer to confirm invoking `/02-solid-architect` to compile `<scenario-id>.json` into a SOLID `.spec.ts`.
