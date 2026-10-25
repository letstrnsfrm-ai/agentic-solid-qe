---
name: 02-solid-architect
description: Compiles JSON Session Tapes into a deterministic, multi-page SOLID Playwright TypeScript suite. Invoke /02-solid-architect to scaffold atomic Components, Pages, Data Builders, Fixtures, and tagged specs, then run npm run verify.
---

# Skill 02: SOLID Playwright Architect

## 0. Zero-Prompt Auto-Start (When Invoked as `/02-solid-architect`)
When invoked without arguments, **immediately run `npm run coverage:gaps`**, select all uncompiled Session Tapes in `.exploratory/tapes/*.json`, and execute Steps 1–3 automatically.

## 1. Validation & Multi-Page Reuse Audit (FR-3.1)
1. Run `npm run validate:tapes` to verify `.exploratory/tapes/*.json`.
2. Scan `src/contracts/`, `src/components/`, `src/pages/`, `src/data/`, and `src/fixtures/` to reuse existing classes across multi-page flows.
3. Follow canonical patterns in `.agents/skills/02-solid-architect/references/solid-patterns.md`.

## 2. SOLID & Multi-Page Generation Rules (FR-3.2)
- **SRP (`src/components/`, `src/pages/`):**
  - Cap each `src/components/*.component.ts` at **150 lines**.
  - **Ban `expect()`** inside `src/components/` and `src/pages/`.
  - Expose action methods, `readonly` semantic `Locator` properties, and deterministic page/network transition synchronization (`waitForUrl`, `waitForNetwork`).
- **OCP & ISP (`src/fixtures/app.fixture.ts`):**
  - Wire Pages and Components into `test.extend<>()`. Specs must import `{ test, expect }` from `@fixtures/app.fixture`.
- **LSP (`src/contracts/`) & DIP (`src/data/`):**
  - Implement shared contracts in `src/contracts/` and centralize all credentials/strings in `src/data/*.builder.ts`.
- **CI Tags & Cross-Page State (`tests/*.spec.ts`):**
  - Apply Session Tape `tags` (`@p0`, `@smoke`, `@regression`) and assert cross-page `capturedVariables`.

## 3. Self-Healing Verification Gate (FR-3.3)
Run and heal until green:
```bash
npm run verify
```
