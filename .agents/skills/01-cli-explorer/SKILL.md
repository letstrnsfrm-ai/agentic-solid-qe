---
name: 01-cli-explorer
description: Exploratory testing, coverage gap analysis, and defect triage via @playwright/cli. Recommends Golden Path charters, runs headed sessions, logs defects, emits Session Tapes, and hands off to 02-solid-architect.
---

# Skill 01: CLI Explorer & Risk-Based Triage

## 1. Gap Analysis & Risk Recommendation (FR-1.1)
1. Run `npm run coverage:gaps` and read `.agents/domain/domain-memory.md` (+ relevant `.agents/domain/shards/*.md`).
2. Open `--headed` recon (`npx playwright-cli -s=explore open <baseUrl> --headed`) and compare `.playwright-cli/page-*.yml` routes against `tests/*.spec.ts`.
3. **Checkpoint 1:** Recommend the **Top 3 Uncovered High-Risk Scenarios** ranked by Golden Path priority (`references/charters.md`). Wait for engineer confirmation (unless a scenario was already specified).

## 2. Headed CLI Execution & Ref Translation (FR-1.2, FR-1.3)
Execute the confirmed charter:
```bash
npx playwright-cli -s=explore fill <ref> "<value>"
npx playwright-cli -s=explore click <ref>
npx playwright-cli -s=explore console error
npx playwright-cli -s=explore close
```
Inspect only `.playwright-cli/page-*.yml` snapshots. Map CLI refs (`e14`) into a **Hierarchical Locator Contract** (`parentScope` + `getByRole`/`getByLabel`/`getByPlaceholder`/`getByTestId`).

## 3. Defect Triage & Sharded Memory (FR-1.4, FR-2.1)
- **Defects:** Run `playwright-cli screenshot` and write `defects/DEFECT-<timestamp>.md` (`references/defect-template.md`).
- **Sharded Memory:** Append quirks to `.agents/domain/shards/<feature>.md` (≤ 150 lines; split and index in `domain-memory.md` if > 120 lines).

## 4. Session Tape & Architect Handoff (FR-1.5)
1. Save verified flows to `.exploratory/tapes/<scenario-id>.json` and run `npm run validate:tapes`.
2. **Checkpoint 2:** Summarize findings and ask the engineer to confirm invoking `02-solid-architect` to compile `<scenario-id>.json` into a SOLID `.spec.ts`.
