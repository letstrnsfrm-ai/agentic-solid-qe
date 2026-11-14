---
name: 02-solid-architect
description: Compiles JSON Session Tapes 1 test at a time into a deterministic SOLID Playwright TypeScript suite (Components, Wizards, Pages, API Clients, Data Builders, Fixtures, and specs).
---

# Skill 02: SOLID Playwright Architect

## 0. 1-Test-at-a-Time Auto-Start (`/02-solid-architect [<scenario-id>]`)
Run `npm run coverage:gaps`, select `<scenario-id>` (or `nextSingleScenarioToAutomate`), and compile & verify **1 Session Tape at a time**.

## 1. Deterministic Compilation & Reuse (FR-3.1)
1. Run `npm run validate:tapes` to verify `.exploratory/tapes/*.json`.
2. Run `npx cortex compile <scenario-id>` (dry-run) and `npx cortex compile <scenario-id> --apply` (`npm run compile:tape`) to reuse existing classes, scaffold missing SOLID files, and sync shard capabilities.
3. Follow `references/solid-patterns.md` and `references/complex-orchestration-guide.md`.

## 2. SOLID, Wizard, API & Multi-Portal Rules (FR-3.2)
- **SRP (`components/`, `pages/`, `api/`):**
  - Cap `*.component.ts` at **150 lines**. Model conditional steps via `WizardStepContract<TRiskProfile>`.
  - **Ban `expect()`** in `components/`, `pages/`, and `api/*.client.ts`.
  - Use `waitForUrl` / `waitForNetwork`, `ApiClientContract`, and `AuthTokenBridge`.
- **OCP & ISP (`fixtures/`):**
  - Wire Pages, API Clients, and Multi-Portal contexts (`browser.newContext({ storageState })`) into `test.extend<>()`.
- **LSP (`contracts/`) & DIP (`data/`):**
  - Centralize risk profiles, relative dates (`RelativeDateHelper`), and constants in `*.builder.ts`.
- **CI Tags & Cross-Portal State (`tests/*.spec.ts`):**
  - Apply `tags` (`@p0`, `@smoke`, `@regression`) and assert `capturedVariables` across UI steps, portals, and API responses.

## 3. Self-Healing Verification Gate (FR-3.3)
Run and heal until green:
```bash
npm run verify
```
