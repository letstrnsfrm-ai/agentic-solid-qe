---
name: 01-cli-explorer
description: Autonomous exploratory testing and defect triage via @playwright/cli. Reads domain-memory.md, runs charters, maps YAML refs to semantic locators, logs defects, and emits JSON Session Tapes.
---

# Skill 01: CLI Explorer & Defect Triage

## 1. Context Loading (FR-1.1)
1. Read `.agents/domain/domain-memory.md` (Hub Index) and load **only** the matching `.agents/domain/shards/<feature>.md` shard(s).
2. Pick a charter (`happy-path-baseline`, `boundary-analysis`, `state-interruption`, `chaos-network-500`, `multi-persona-auth`) from `references/charters.md`.

## 2. CLI Browser Execution (FR-1.2)
Run named `@playwright/cli` sessions (`-s=<name>`) in `--headed` mode so engineers can watch and intervene:
```bash
npx playwright-cli -s=explore open <baseUrl> --headed
npx playwright-cli -s=explore fill <ref> "<value>"
npx playwright-cli -s=explore click <ref>
npx playwright-cli -s=explore console error
npx playwright-cli -s=explore close
```
Inspect only `.playwright-cli/page-*.yml` disk snapshots; never stream raw HTML.

## 3. Hierarchical Ref Translation (FR-1.3)
Never output ephemeral CLI refs (`e14`). Map `.playwright-cli/page-*.yml` nodes into a **Hierarchical Locator Contract**:
- Use `getByRole`, `getByLabel`, `getByPlaceholder`, or `getByTestId`.
- Populate `parentScope` for repeating cards, rows, or dialogs.
- Use `playwright-cli eval` only when accessibility role/name is missing.

## 4. Defect Triage & Sharded Memory (FR-1.4, FR-2.1)
- **Defects:** Run `playwright-cli screenshot` and log `defects/DEFECT-<timestamp>.md` per `references/defect-template.md`.
- **Sharded Memory:** Append new quirks to `.agents/domain/shards/<feature>.md` (cap each file at ≤ 150 lines; split and index in `domain-memory.md` when > 120 lines).

## 5. Session Tape Emission (FR-1.5)
Export verified flows to `.exploratory/tapes/<scenario-id>.json` per `session-tape.schema.json` and run `npm run validate:tapes`.
