---
name: 01-cli-explorer
description: Autonomous feature discovery, multi-page/multi-portal exploration, backend API discovery, and 1-test-at-a-time coverage curation via @playwright/cli.
---

# Skill 01: CLI Explorer, Feature Recon & Coverage Curator

## 1. Zero-Prompt Auto-Start: Recon & Gap Analysis (FR-1.1)
When invoked as `/01-cli-explorer` (invoke `/playwright-cli` for CLI syntax without `--help` round trips):
1. Run `npm run coverage:gaps` and read `.agents/domain/domain-memory.md` (+ `shards/*.md`).
2. Start **Fresh Recon** (`npx playwright-cli -s=explore open <baseUrl> --headed`), **Resume-from-Spec (`A ➔ B ➔ C`)** via `npm run test:explore` / `--debug` + `playwright-cli attach`, or **Human Codegen Recording** (`recording-start` / `playwright codegen`, `references/charters.md` §0b–0c).
3. **Checkpoint 1:** Present **Top 3 Uncovered Scenarios** (`references/charters.md`) and pick **1** to explore.

## 2. Multi-Page, Multi-Portal & API Recon (FR-1.2, FR-1.3)
Traverse with multi-oracle checks (`references/charters.md`):
- **State & Actors:** Snapshot `.playwright-cli/page-step.yml` and `eval "() => location.href"`; record `conditionRef` and `actors`.
- **Locator Contract:** Map YAML refs (`e14`) to `parentScope` + `filterTextRef` + semantic locators.
- **API Telemetry:** Run `console error`; record `clientCandidate` and `responseSchemaSummary` in `networkContracts`.

## 3. Defect Triage & Shards (FR-1.4, FR-2.1)
- **Defects:** `playwright-cli screenshot` + `defects/DEFECT-<timestamp>.md` (`references/defect-template.md`).
- **Shards:** Update `.agents/domain/shards/<feature>.md` (≤ 150 lines).

## 4. Debrief & Tape Emission (FR-1.5)
1. **Checkpoint 2:** Present the **Session Debrief Matrix** (`references/charters.md`).
2. Extend parent tape (`B ➔ C`) or emit `.exploratory/tapes/<scenario-id>.json` (`resumesFrom`), run `npm run validate:tapes` + `npm run domain:graph -- --seed-from-tapes`, and hand off to `/02-solid-architect <scenario-id>`.
