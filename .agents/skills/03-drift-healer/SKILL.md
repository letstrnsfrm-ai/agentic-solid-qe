---
name: 03-drift-healer
description: Diagnoses failing Playwright .spec.ts tests against live deployed environments via agent-browser to separate genuine application regressions from UI, wizard, API contract, or auth session drift.
---

# Skill 03: Live Drift Healer & Failure Triage

## 1. Zero-Prompt Auto-Start: Compact Failure Isolation
When invoked as `/03-drift-healer`:
1. Run `npm run verify:fast -- --specs <spec>` (compact failure-only output) and `npx cortex context --spec <spec>` (`≤ 400` tok) to inspect the failing spec, its SOLID component locators, shard, and linked tape in 1 call.
2. Run `npx cortex heal [--spec <spec>]` (compact dry-run triage card) to score live/error-context snapshot candidates before opening a browser.

## 2. Live `agent-browser` Differential Inspection (If Needed)
1. Attach to the failing route (`npm run test:explore -- <spec>`) via `npx agent-browser --session heal --cdp 9222 snapshot -i`, or `npx agent-browser --session heal open <baseUrl>`.
2. Capture `.agent-browser/page-heal.yml`, `eval "location.href"`, `console`, and `errors`, then compare against the tape summary (`npx cortex tape show <id>`).

## 3. Root-Cause Classification & Action
- **App Regression:** Never weaken `expect()`. Capture `screenshot defects/evidence.png --annotate`, log `defects/DEFECT-<timestamp>.md`, mark `test.fixme()`/`test.fail()`, pause for review.
- **Expired `.auth/<persona>.json` (`401/403`):** Refresh via `00-env-bootstrap` before editing code.
- **UI/Wizard/API/Sandbox Drift:** Run `npx cortex heal --apply` (or `npx cortex tape patch` + `src/` patch), update shard `**Last Verified:**`, and run `npm run verify:fast -- --specs <spec>` ➔ `npm run verify`.

## 4. Lazy Reference Index (Read ONLY When Needed)
- `references/healing-playbook.md` — 8-Way Differential Diagnosis Matrix (Bug vs. Drift vs. Auth/Sandbox).
- `references/drift-patch-and-verify.md` — Safe healing protocol, tape/component patch rules & verification flow.
