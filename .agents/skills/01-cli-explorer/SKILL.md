---
name: 01-cli-explorer
description: Autonomous feature discovery, multi-page/multi-portal exploration, backend API discovery, and 1-test-at-a-time coverage curation via @playwright/cli.
---

# Skill 01: CLI Explorer, Feature Recon & Coverage Curator

## 1. Zero-Prompt Auto-Start: Feature Recon & Gap Analysis (FR-1.1)
When invoked as `/01-cli-explorer`:
1. Run `npm run coverage:gaps` and read `.agents/domain/domain-memory.md` (+ `shards/*.md`).
2. Open `--headed` recon (`npx playwright-cli -s=explore open <baseUrl> --headed`). Reopen sessions via `.playwright/cli.config.json` (`storageState`).
3. **Checkpoint 1:** Present the **Top 3 Uncovered High-Risk Scenarios** (`references/charters.md`) and ask which **single scenario** to explore first.

## 2. Multi-Page, Multi-Portal & Backend API Recon (FR-1.2, FR-1.3)
Traverse the flow with multi-oracle checks (`references/charters.md`):
- **SPA, Wizard & Cross-Portal Truth:** Snapshot `.playwright-cli/page-step.yml` and `eval "() => location.href"`. Record wizard `conditionRef` and cross-portal `actors`.
- **Locator Contract:** Map YAML refs (`e14`) to `parentScope` + `filterTextRef` + `getByRole`/`getByLabel`/`getByTestId`.
- **Backend API Telemetry:** Run `console error` and capture API endpoints, status, `clientCandidate`, and `responseSchemaSummary` in `networkContracts`.

## 3. Defect Triage & Sharded Memory (FR-1.4, FR-2.1)
- **Defects:** Run `playwright-cli screenshot` and log `defects/DEFECT-<timestamp>.md` (`references/defect-template.md`).
- **Shards:** Append routes, `apiBaseUrl`, API schemas, and rules to `.agents/domain/shards/<feature>.md` (≤ 150 lines).

## 4. 1-Test-at-a-Time Debrief & Tape Emission (FR-1.5)
1. **Checkpoint 2:** Present the **Session Debrief & Candidate Regression Matrix** (`references/charters.md`).
2. Emit 1 `.exploratory/tapes/<scenario-id>.json` (`npm run validate:tapes`), run `npm run domain:graph -- --seed-from-tapes`, and hand off to `/02-solid-architect <scenario-id>`.
