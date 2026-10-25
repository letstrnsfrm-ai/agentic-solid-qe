# GitHub Copilot Instructions — `agentic-solid-qe`

When assisting in this repository, route your workflow through the two core skills in `.agents/skills/`:

1. **Exploratory Testing & Bug Triage (`01-cli-explorer`):**
   - Follow `.agents/skills/01-cli-explorer/SKILL.md`.
   - Load context from `.agents/domain/domain-memory.md`.
   - Drive browser sessions via `npx playwright-cli -s=<name>`, translate ephemeral `.playwright-cli/page-*.yml` refs (`e14`) into hierarchical semantic locators, log bugs in `defects/`, and output JSON Session Tapes to `.exploratory/tapes/` matching `.agents/domain/session-tape.schema.json`.

2. **SOLID Playwright Architecture (`02-solid-architect`):**
   - Follow `.agents/skills/02-solid-architect/SKILL.md`.
   - Audit existing classes in `src/contracts/`, `src/components/`, `src/pages/`, `src/data/`, and `src/fixtures/` before creating new files.
   - Enforce SRP (`src/components/*.component.ts` ≤ 150 lines, zero `expect()` in Pages/Components), OCP/ISP (`test.extend` fixtures in `src/fixtures/`), LSP (`src/contracts/`), and DIP (typed data builders in `src/data/`).
   - Always verify changes with `npm run audit:solid` and `npx playwright test`.
