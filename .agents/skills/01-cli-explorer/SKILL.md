---
name: 01-cli-explorer
description: Autonomous exploratory testing and defect triage via @playwright/cli. Reads domain-memory.md, runs charters, maps YAML refs to semantic locators, logs defects, and emits JSON Session Tapes.
---

# Skill 01: CLI Explorer & Defect Triage

## 1. Context Loading (FR-1.1)
1. Read `.agents/domain/domain-memory.md` for URLs, personas, and business rules.
2. Pick a charter (`happy-path-baseline`, `boundary-analysis`, `state-interruption`, `chaos-network-500`, `multi-persona-auth`) from `.agents/skills/01-cli-explorer/references/charters.md`.

## 2. CLI Browser Execution (FR-1.2)
Run named `@playwright/cli` sessions (`-s=<name>`) in `--headed` mode by default so engineers can watch live and intervene (e.g., MFA/CAPTCHA):
```bash
npx playwright-cli -s=explore open <baseUrl> --headed
npx playwright-cli -s=explore fill <ref> "<value>"
npx playwright-cli -s=explore click <ref>
npx playwright-cli -s=explore console error
npx playwright-cli -s=explore close
```
Inspect only `.playwright-cli/page-*.yml` disk snapshots; never stream full HTML into context.

## 3. Hierarchical Ref Translation (FR-1.3)
Never output ephemeral CLI refs (`e14`). Translate every step from `.playwright-cli/page-*.yml` into a **Hierarchical Locator Contract**:
- Use `getByRole`, `getByLabel`, `getByPlaceholder`, or `getByTestId`.
- Populate `parentScope` for repeating containers (cards, rows, dialogs).
- Use `playwright-cli eval` only if accessibility role/name is missing.

## 4. Defect Triage & Domain Learning (FR-1.4, FR-2.1)
- **Defects:** Capture `playwright-cli screenshot` and write `defects/DEFECT-<timestamp>.md` per `references/defect-template.md`.
- **Discoveries:** Append new app quirks under `## 4. Discovered Behaviours` in `domain-memory.md`.

## 5. Session Tape Emission (FR-1.5)
Write verified flows to `.exploratory/tapes/<scenario-id>.json` per `.agents/domain/session-tape.schema.json` and run `npm run validate:tapes`.
