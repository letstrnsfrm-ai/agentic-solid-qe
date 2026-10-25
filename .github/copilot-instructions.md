# GitHub Copilot Instructions — `agentic-solid-qe`

When assisting in this repository, route your workflow through the five core skills in `.agents/skills/`:

1. **Environment, Auth & App Map Bootstrap (`00-env-bootstrap`):**
   - Follow `.agents/skills/00-env-bootstrap/SKILL.md`.
   - Configure `baseUrl`, capture reusable `.auth/<persona>.json` sessions for SSO/MFA apps, and discover top-level navigation shards in `.agents/domain/domain-memory.md`.

2. **Exploratory Testing, Feature Recon & Coverage Curation (`01-cli-explorer`):**
   - Follow `.agents/skills/01-cli-explorer/SKILL.md`.
   - Load context from `.agents/domain/domain-memory.md` and `.agents/domain/shards/*.md`.
   - Drive browser sessions via `npx playwright-cli -s=<name>`, map unfamiliar multi-page flows, check API/console/state/a11y heuristics, log bugs in `defects/`, present the **Session Debrief & Coverage Selection Matrix**, and output QE-selected JSON Session Tapes to `.exploratory/tapes/` matching `.agents/domain/session-tape.schema.json`.

3. **SOLID Playwright Architecture (`02-solid-architect`):**
   - Follow `.agents/skills/02-solid-architect/SKILL.md`.
   - Audit existing classes in `src/contracts/`, `src/components/`, `src/pages/`, `src/data/`, and `src/fixtures/` before creating new files.
   - Enforce SRP (`src/components/*.component.ts` ≤ 150 lines, zero `expect()` in Pages/Components), OCP/ISP (`test.extend` fixtures in `src/fixtures/`), LSP (`src/contracts/`), and DIP (typed data builders in `src/data/`).
   - Always verify changes with `npm run verify`.

4. **Live Failure Triage & Drift Healing (`03-drift-healer`):**
   - Follow `.agents/skills/03-drift-healer/SKILL.md`.
   - Inspect failing specs against live routes via `@playwright/cli` to separate genuine application regressions (`defects/DEFECT-*.md`) from harmless UI/locator/flow drift.

5. **CI/CD Pipeline & Regression Suite Curation (`04-ci-pipeline`):**
   - Follow `.agents/skills/04-ci-pipeline/SKILL.md`.
   - Ensure specs carry `@p0`/`@smoke`/`@regression` tags and configure sharded CI/CD execution pipelines.
