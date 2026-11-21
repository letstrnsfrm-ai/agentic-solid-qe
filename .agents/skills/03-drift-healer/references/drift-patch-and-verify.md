# Safe Drift Patching & Verification Protocol

> Read on-demand when applying a drift fix (Cases #1–#5 or #8 from `references/healing-playbook.md`).

## 1. Refresh Expired Auth First (Case #4)
If `.auth/<persona>.json` expired (`401`/`403`), invoke `00-env-bootstrap` (or `npx playwright test --project=setup`) and re-run `npm run verify:fast -- --specs <spec>` before editing any code or tapes.

## 2. Deterministic Auto-Heal & Blast-Radius Gate (`npx cortex heal`)
```bash
npx cortex heal --spec tests/<failing>.spec.ts                          # dry-run triage card + blast radius
npx cortex heal --spec tests/<failing>.spec.ts --apply                  # patches low-fan-in Component + Tape
npx cortex heal --spec tests/<failing>.spec.ts --apply --verify-affected # transactional shared-module heal (auto-rolls back on regression)
```
- Only safe semantic Playwright locators (`getByRole`, `getByLabel`, `getByPlaceholder`, `getByTestId`, etc.) pass the locator allowlist.
- **Shared-Module Guardrail:** If the target module is in `src/shared/` or consumed by `>= 3` specs / `>= 2` squads, `--apply` blocks blind edits (`blocked-shared-blast-radius`). Use `--verify-affected` to run all affected specs (including `@regression`) and automatically restore files if any unrelated spec regresses, or prefer additive OCP overrides.
- If `classification === 'regression'`, `cortex heal --apply` writes a secret-redacted `defects/DEFECT-<timestamp>.md` and never weakens assertions.

## 3. Manual / Complex Drift Updates
1. **Check Blast Radius First:** Run `npx cortex impact --file <src-file>` (or `npx cortex context --file <src-file>`) before editing shared Components, Pages, Flows, or Data Builders.
2. **Update Source-of-Truth Tape:** Use `npx cortex tape patch <scenarioId> ...`, then run `npm run validate:tapes` (confirming zero ephemeral `@e14` refs).
3. **Heal SOLID Layer (`src/`):** Keep components/steps/seeders `<= 150` lines with zero `expect()`, and keep squad internals isolated (`src/domains/<squad>/` cannot import another squad's internals).
4. **Update Domain Shard & Verify:** Refresh `**Last Verified:** YYYY-MM-DD`, then run `npm run verify:fast -- --specs tests/<spec>.spec.ts` (auto-expands affected specs up to cap) ➔ `npm run verify` (runs `@smoke|@p0` + affected `@regression`).
