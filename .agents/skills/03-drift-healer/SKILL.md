---
name: 03-drift-healer
description: Diagnoses failing Playwright .spec.ts tests against live deployed environments via agent-browser to separate genuine application regressions from UI, wizard, API contract, or auth session drift.
---

# Skill 03: Live Drift Healer & Failure Triage

## 1. Zero-Prompt Auto-Start: Compact Failure Isolation
When invoked as `/03-drift-healer`:
1. Run `npm run verify:fast -- --specs <spec>` and `npx cortex context --spec <spec>` (`≤ 400` tok) to inspect the failing spec, SOLID component locators, shard, and tape in 1 call.
2. Run `npx cortex heal [--spec <spec>]` (compact dry-run triage card) to score snapshot candidates before opening a browser.

## 2. Live `agent-browser` Differential Inspection (If Needed)
1. Attach to the failing route (`npm run test:explore -- <spec>`) via `npx agent-browser --session heal --cdp 9222 snapshot -i`, or `npx agent-browser --session heal open <baseUrl>`.
2. Capture `.agent-browser/page-heal.yml`, `eval "location.href"`, `console`, and `errors`, then compare against `npx cortex tape show <id>`.

## 3. Root-Cause Classification & Action
- **App / NFR Regression:** Never weaken `expect()` or loosen `NfrBudgetBuilder` thresholds (`@a11y`/`@perf`/`@security`). Capture `screenshot defects/evidence.png --annotate`, log `defects/DEFECT-<timestamp>.md`, mark `test.fixme()`/`test.fail()`, pause for review.
- **Expired `.auth/<persona>.json` (`401/403`):** Refresh via `00-env-bootstrap` before editing code.
- **UI/Wizard/API/Sandbox Drift:** Run `npx cortex heal --apply` (`--verify-affected` for shared modules), refresh shard `**Last Verified:**`, run `npm run verify:fast -- --specs <spec>` ➔ `npm run verify`.

## 4. Lazy Reference Index (Read ONLY When Needed)
- `references/healing-playbook.md` — 8-Way Differential Diagnosis Matrix (Bug vs. Drift vs. Auth/Sandbox).
- `references/drift-patch-and-verify.md` — Safe healing, shared-module rollback, patch & verify flow.
