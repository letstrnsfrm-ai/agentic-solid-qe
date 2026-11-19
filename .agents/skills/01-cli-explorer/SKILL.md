---
name: 01-cli-explorer
description: Autonomous feature discovery, multi-page/multi-portal exploration, API discovery, and 1-test-at-a-time coverage curation via agent-browser.
---

# Skill 01: CLI Explorer, Feature Recon & Coverage Curator

## 1. Zero-Prompt Auto-Start: Recon & Gap Analysis (FR-1.1)
When invoked as `/01-cli-explorer` (use `/agent-browser` for CLI syntax):
1. Run `npm run coverage:gaps` and read `.agents/domain/domain-memory.md` (+ `shards/*.md`).
2. **High-Speed Resume (`npx cortex explore`):** Start via `--from-spec <spec> [--until-step "<step>"]`, `--from-seed <seeder> --url <url>`, or `<1s` `--checkpoint <name>` (headless default; `--headed` optional). Use `--url <baseUrl>` only for new routes (`references/charters.md` §0b–0c).
3. **Checkpoint 1:** Present **Top 3 Uncovered Scenarios** (`references/charters.md`) and pick **1** to explore.

## 2. Batched Multi-Page, Multi-Portal & API Recon (FR-1.2, FR-1.3)
Traverse via `cortex explore` (auto-resolves `@e<N>` locators, redacts secrets, captures network/errors, returns compact `-i` deltas):
- **Actions:** `npx cortex explore act <cmd> ... --step "<business>"` or `batch '[...]'`.
- **Cross-Portal & State:** `capture <var>` + `actor <id> --url <url>` + `checkpoint save <name>`.
- **A11y & Oracles:** Run `a11y --json` and multi-oracle checks (`references/charters.md`).

## 3. Defect Triage & Shards (FR-1.4, FR-2.1)
- **Defects:** `npx agent-browser --session explore screenshot defects/evidence.png --annotate` + `defects/DEFECT-<timestamp>.md` (`references/defect-template.md`).
- **Shards:** Update `.agents/domain/shards/<feature>.md` (≤ 150 lines).

## 4. Debrief & 1-Command Compilation (FR-1.5)
1. **Checkpoint 2:** Present the **Session Debrief Matrix** (`references/charters.md`).
2. Run `npx cortex explore finish --scenario <id> --compile` + `npm run domain:graph -- --seed-from-tapes`.
