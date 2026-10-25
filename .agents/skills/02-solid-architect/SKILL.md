---
name: 02-solid-architect
description: Compiles JSON Session Tapes into a SOLID Playwright TypeScript suite. Invoke with /02-solid-architect to auto-detect uncompiled Session Tapes, scaffold atomic Components, Pages, Data Builders, and Fixtures, and run npm run verify.
---

# Skill 02: SOLID Playwright Architect

## 0. Zero-Prompt Auto-Start (When Invoked as `/02-solid-architect`)
When invoked without arguments, **immediately run `npm run coverage:gaps`**, select the latest uncompiled Session Tape in `.exploratory/tapes/*.json`, and execute Steps 1–3 below automatically.

## 1. Validation & De-duplication Audit (FR-3.1)
1. Run `npm run validate:tapes` to verify `.exploratory/tapes/*.json`.
2. Scan `src/contracts/`, `src/components/`, `src/pages/`, `src/data/`, and `src/fixtures/` to reuse existing locators and methods.
3. Follow code templates in `.agents/skills/02-solid-architect/references/solid-patterns.md`.

## 2. SOLID Generation Rules (FR-3.2)
- **SRP (`src/components/`, `src/pages/`):**
  - Cap each `src/components/*.component.ts` at **150 lines**.
  - **Ban `expect()`** in `src/components/` and `src/pages/`.
  - Expose action methods (`fill`, `click`) and `readonly` semantic `Locator` properties so `tests/*.spec.ts` executes web-first assertions (`await expect(comp.el).toBeVisible()`).
- **OCP & ISP (`src/fixtures/`):**
  - Wire Pages and Components into `test.extend<>()` fixtures (`src/fixtures/app.fixture.ts`). Specs must import `{ test, expect }` from `@fixtures/app.fixture`.
- **LSP (`src/contracts/`):**
  - Every Component must implement a contract interface from `src/contracts/`.
- **DIP (`src/data/`):**
  - Centralize credentials and expected strings in `src/data/*.builder.ts`. Ban magic strings in `.spec.ts`.

## 3. Self-Healing Verification Gate (FR-3.3)
Run and heal until green:
```bash
npm run verify
```
