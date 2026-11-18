---
name: 03-drift-healer
description: Diagnoses failing Playwright .spec.ts tests against live deployed environments via agent-browser (or @playwright/cli fallback) to separate genuine application regressions from UI, wizard, API contract, or auth session drift. Invoke /03-drift-healer when CI or local specs fail.
---

# Skill 03: Live Drift Healer & Failure Triage

## 1. Zero-Prompt Auto-Start: Failure Isolation
When invoked as `/03-drift-healer`:
1. Run `npx playwright test` (or target `.spec.ts`) and read `.agents/domain/domain-memory.md`.
2. Extract failing `scenarioId`, actor/portal, step, locator/endpoint, and stack trace, then cross-reference `.exploratory/tapes/<scenarioId>.json` and Domain Shards.

## 2. Live `agent-browser` & API Differential Inspection (`references/healing-playbook.md`)
1. Invoke `/agent-browser` for syntax, then attach to the failing test (`npm run test:explore -- <spec>`) via `npx --yes agent-browser --session heal --cdp 9222 snapshot -i`, or `npx --yes agent-browser --session heal --headed open <baseUrl>`.
2. Run `mkdir -p .agent-browser && npx --yes agent-browser --session heal snapshot > .agent-browser/page-heal.yml`, `eval "location.href"`, `console`, and `errors`.
3. Compare live UI, wizard steps, `.auth/<persona>.json` validity, and API responses against the Session Tape.

## 3. 7-Way Root-Cause Classification & Action (`references/healing-playbook.md`)
Run `npx cortex heal` (dry-run) / `npx cortex heal --apply` or triage manually:
- **Case A — App Regression:** Never weaken assertions. Capture `npx --yes agent-browser --session heal screenshot defects/evidence.png --annotate`, log `defects/DEFECT-<timestamp>.md`, mark `test.fixme()`/`test.fail()`.
- **Case B — Expired `.auth/<persona>.json` (`401/403`):** Re-capture auth via `00-env-bootstrap` (pause only for MFA/CAPTCHA).
- **Case C — UI/Wizard/API/Sandbox Drift:** Heal tape, `src/`, and Shards autonomously, then run `npm run verify`.
