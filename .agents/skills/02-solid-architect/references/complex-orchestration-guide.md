# Complex Application, Multi-Portal & API Orchestration Decision Guide

> Read on-demand to classify complex scenarios into Pattern A, B1/B2, C, or D before compiling 1 vertical slice at a time.

## 1. Pattern Selection Matrix
| Scenario Shape | Pattern | Charter / Contract | Reference to Read Next |
| :--- | :--- | :--- | :--- |
| **5–12 step conditional form / wizard** (single portal, starts at Step 1) | **Pattern A** | `happy-path-baseline` / `boundary-analysis` + `WizardStepContract<T>` | `references/pattern-wizard-steps.md` |
| **Standalone backend API / rating engine rule** | **Pattern B1** | `api-contract` + `ApiClientContract` + `AuthTokenBridge` | `references/pattern-api-and-seeders.md` |
| **Single portal needing upstream Quote/Policy state** | **Pattern B2** | Step 1 `action: "apiCall"` / `StateSeederContract` ➔ UI steps | `references/pattern-api-and-seeders.md` |
| **True UI-to-UI multi-portal handoff** (Customer ➔ Agent Portal) | **Pattern C** | `cross-portal-handoff` + `actors[]` + isolated `BrowserContext`s | `references/pattern-cross-portal.md` |
| **Long (>10-step) flow split into Point A ➔ Point B** | **Pattern D** | `resumesFrom` (`api-seed`, `checkpoint-state`, `ui-prereq`) + `StateSeederContract` | `references/pattern-api-and-seeders.md` |

## 2. Strict 1-Test-at-a-Time Vertical Slice Protocol
Never batch-generate 10 unverified specs on complex apps. Execute one business slice at a time:
1. **Inspect Scoped Context (1 call):** Run `npx cortex context --squad <squad>` (or `npm run coverage:gaps -- --compact`) to pick `nextSingleScenarioToAutomate` and inspect reusable `src/domains/<squad>/` symbols.
2. **Explore & Emit 1 Tape (`/01-cli-explorer`):** Traverse via `npx cortex explore`, capturing wizard `conditionRef`, runtime `capturedVariables`, and `networkContracts` (`clientCandidate`, `responseSchemaSummary`). Validate via `npm run validate:tapes`.
3. **Compile & Verify (`/02-solid-architect <scenario-id>`):** Run `npx cortex compile <scenario-id> --apply`, reuse existing classes, then run `npm run verify:fast -- --specs tests/<spec>.spec.ts` until green and `npm run verify` at loop end.

## 3. Multi-Squad Layout (`src/domains/<squad>/`)
Partition teams via `npx cortex sync --squad <squad>` so each squad owns isolated `api/`, `components/`, `pages/`, `steps/`, `seeders/`, `data/`, `fixtures/` under `src/domains/<squad>/` and shards under `.agents/domain/domains/<squad>/`.
*(For consumer upgrade details, see `00-master-orchestrator/references/onboarding-and-upgrade.md`.)*
