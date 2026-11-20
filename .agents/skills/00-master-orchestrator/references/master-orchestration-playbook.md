# Master Orchestration Playbook — 5-Stage Coverage Ladder & Contracts

> Read on-demand when explaining capabilities or advancing a repo through Stages 0–4 **1 test at a time**.

## 1. Built-In SOLID Contracts & Shared Helpers (`src/`)
| Symbol | Path | Role |
| :--- | :--- | :--- |
| `IdentifiableComponent` | `src/contracts/identifiable-component.contract.ts` | Root LSP contract (`readonly root: Locator`), `≤ 150`L, zero `expect()`. |
| `ErrorBannerContract` | `src/contracts/error-banner.contract.ts` | Validation/alert banner (`errorBanner`, `dismissError()`). |
| `WizardStepContract<T>` | `src/contracts/wizard-step.contract.ts` | Conditional 5–12 step wizards (`isApplicable`, `completeStep`). |
| `ApiClientContract` | `src/contracts/api-client.contract.ts` | Typed `APIRequestContext` clients returning `ApiResponseEnvelope<T>`. |
| `StateSeederContract` | `src/contracts/state-seeder.contract.ts` | Composable API-first seeders with fixture auto-teardown. |
| `FlowContract` | `src/contracts/flow.contract.ts` | Reusable Point-A UI preamble flows for `resumesFrom`. |
| `AuthTokenBridge` | `src/shared/api/auth-token.bridge.ts` | Extracts Bearer/cookie headers from `.auth/<persona>.json`. |
| `RelativeDateHelper` | `src/shared/data/relative-date.helper.ts` | Deterministic relative dates in Data Builders. |

## 2. The 5-Stage Incremental Coverage Ladder
- **Stage 0 — Foundation & Legacy Onboarding:** `init` or `upgrade:skills` (`references/onboarding-and-upgrade.md`), `migrate:skill --discover` ➔ `05-skill-migrator`, `00-env-bootstrap` (`baseUrl`, `.auth/*.json`, shards), `npm run domain:graph`. *Exit:* valid URL/auth, indexed shards + `reports/system-map.html`.
- **Stage 1 — P0 Baseline (`@p0`, 1 Test at a Time):** `01-cli-explorer` (`happy-path-baseline`) on first uncovered shard ➔ human picks 1 ➔ `02-solid-architect` (`cortex compile <id> --apply`) ➔ `verify:fast` ➔ `verify`. *Exit:* 0 uncovered shards/uncompiled tapes, `test:p0` green.
- **Stage 2 — Persona, Boundary & Resilience (`@smoke`/`@regression`):** Reuse Pages/Components/Builders via `multi-persona-auth`, `boundary-analysis`, `state-interruption`, `accessibility-audit` (`cortex tape clone|patch`). *Exit:* positive + negative/boundary specs per shard.
- **Stage 3 — Wizards, APIs & Cross-Portal:** Partition squads (`cortex sync --squad <sq>`), Pattern A (`WizardStepContract`), Pattern B (`ApiClientContract` + `AuthTokenBridge`), Pattern C (`cross-portal-handoff` isolated `BrowserContext`s), Pattern D (`StateSeederContract`/`resumesFrom`). *Exit:* `unimplementedApiClients === 0`, `verify` green.
- **Stage 4 — Sharded CI & Drift Healing:** `04-ci-pipeline` (tags + sharded CI) + `03-drift-healer` (`cortex heal --apply` for drift; `defects/DEFECT-*.md` for real bugs). *Exit:* `staleShards === 0`, tagged CI green.
