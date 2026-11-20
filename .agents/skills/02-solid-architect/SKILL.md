---
name: 02-solid-architect
description: Compiles JSON Session Tapes 1 test at a time into a deterministic SOLID Playwright TypeScript suite (Components, Wizards, Pages, API Clients, Data Builders, Fixtures, and specs).
---

# Skill 02: SOLID Playwright Architect

## 1. Single-Call Context & Compilation (FR-3.1)
1. Run `npx cortex context --tape <scenario-id>` (`≤ 400` tok) to view tape DSL and reusable `src/` symbols.
2. Compile **1 Session Tape at a time**:
   ```bash
   npx cortex compile <scenario-id> --compact         # compact dry-run
   npx cortex compile <scenario-id> --apply --compact # scaffold SOLID TS & sync shard
   ```
3. Run `npm run verify:fast -- --specs tests/<spec>.spec.ts` (inner loop), then `npm run verify` once green.

## 2. Non-Negotiable SOLID Rules (FR-3.2, FR-3.3)
- **SRP (`components/`, `pages/`, `api/`, `seeders/`):** Cap components/steps/seeders at **150 lines**. **Ban `expect()`** outside `tests/*.spec.ts`.
- **OCP/ISP (`fixtures/`):** Wire Pages, API Clients, Seeders & Multi-Portal `BrowserContext`s via `test.extend<>()`.
- **LSP/DIP (`contracts/`, `data/`):** Implement contracts; store personas, copy & `RelativeDateHelper` dates in `*.builder.ts`.
- **Specs (`tests/*.spec.ts`):** Group actions & web-first assertions into business-domain `test.step()` blocks (never UI mechanics) with `@p0`/`@smoke`/`@regression` tags.

## 3. Lazy References (Read ONLY When Needed)
- `references/solid-patterns.md` — Core Component, Page, Builder, Fixture & `test.step()` templates.
- `references/ui-resilience-and-scale.md` — Overlays, iframes, portals, Shadow DOM & worker-scoped fixtures.
- `references/complex-orchestration-guide.md` — Pattern A/B/C/D decision matrix.
- `references/pattern-wizard-steps.md` — Pattern A: `WizardStepContract<T>`.
- `references/pattern-api-and-seeders.md` — Pattern B/D: `ApiClientContract`, `resumesFrom`, `StateSeederContract`.
- `references/pattern-cross-portal.md` — Pattern C: Multi-actor isolated `BrowserContext`s.
