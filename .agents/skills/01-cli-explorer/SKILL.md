---
name: 01-cli-explorer
description: Autonomous feature discovery, multi-page/multi-portal exploration, API discovery, and 1-test-at-a-time coverage curation via agent-browser.
---

# Skill 01: CLI Explorer, Feature Recon & Coverage Curator

## 1. Zero-Prompt Auto-Start: Recon & Gap Analysis (FR-1.1)
When invoked as `/01-cli-explorer` (use `/agent-browser` for CLI syntax):
1. Run `npm run coverage:gaps` and read `.agents/domain/domain-memory.md` (+ `shards/*.md`).
2. Start **Fresh Recon** (`npx --yes agent-browser --session explore --headed open <baseUrl>`), **Resume-from-Spec (`A ➔ B ➔ C`)** (`npm run test:explore` + `--cdp 9222`), or **Codegen** (`references/charters.md` §0b–0c).
3. **Checkpoint 1:** Present **Top 3 Uncovered Scenarios** (`references/charters.md`) and pick **1** to explore.

## 2. Multi-Page, Multi-Portal & API Recon (FR-1.2, FR-1.3)
Traverse with multi-oracle checks (`references/charters.md`):
- **State & Actors:** Run `snapshot -i` and `eval "location.href"`; record `conditionRef` and `actors`.
- **Locator Contract:** Map `@e<N>` refs to `parentScope`, `filterTextRef`, and semantic locators.
- **API & A11y Telemetry:** Run `console`, `errors`, `network requests`, `a11y --json`; record `networkContracts`.

## 3. Defect Triage & Shards (FR-1.4, FR-2.1)
- **Defects:** `npx --yes agent-browser --session explore screenshot defects/evidence.png --annotate` + `defects/DEFECT-<timestamp>.md` (`references/defect-template.md`).
- **Shards:** Update `.agents/domain/shards/<feature>.md` (≤ 150 lines).

## 4. Debrief & Tape Emission (FR-1.5)
1. **Checkpoint 2:** Present the **Session Debrief Matrix** (`references/charters.md`) for human selection.
2. Emit/extend `.exploratory/tapes/<scenario-id>.json`, run `npm run validate:tapes` + `npm run domain:graph -- --seed-from-tapes`, and autonomously run `02-solid-architect` on `<scenario-id>`.
