# Safe Drift Patching & Verification Protocol

> Read on-demand when applying a drift fix (Cases #1–#5 or #8 from `references/healing-playbook.md`).

## 1. Refresh Expired Auth First (Case #4)
If `.auth/<persona>.json` expired (`401`/`403`), invoke `00-env-bootstrap` (or `npx playwright test --project=setup`) and re-run `npm run verify:fast -- --specs <spec>` before editing any code or tapes.

## 2. Deterministic Auto-Heal (`npx cortex heal`)
```bash
npx cortex heal --spec tests/<failing>.spec.ts                # compact dry-run triage card
npx cortex heal --spec tests/<failing>.spec.ts --apply        # patches Component + Tape when score >= 0.65
```
- Only safe semantic Playwright locators (`getByRole`, `getByLabel`, `getByPlaceholder`, `getByTestId`, etc.) pass the locator allowlist.
- If `classification === 'regression'`, `cortex heal --apply` writes a secret-redacted `defects/DEFECT-<timestamp>.md` and never weakens assertions.

## 3. Manual / Complex Drift Updates
1. **Update Source-of-Truth Tape:** Use `npx cortex tape patch <scenarioId> ...` (never hand-edit 200+ lines of raw JSON unless updating `locatorContract`/`networkContracts`), then run `npm run validate:tapes` (confirming zero ephemeral `@e14` refs).
2. **Heal SOLID Layer (`src/`):**
   - Keep `src/components/` & `src/domains/**/components/` **`≤ 150` lines** and **zero `expect()`**.
   - Keep `src/domains/**/api/*.client.ts` implementing `ApiClientContract` with **zero `expect()`**.
3. **Update Domain Shard:** Record updated locator/condition/schema and refresh `**Last Verified:** YYYY-MM-DD` in `.agents/domain/shards/*.md` (or `domains/<squad>/shards/*.md`).
4. **Verify:** Run `npm run verify:fast -- --specs tests/<spec>.spec.ts` (inner loop), then `npm run verify` once green.
