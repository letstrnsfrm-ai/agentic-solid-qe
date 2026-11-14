# GitHub Copilot Instructions — `agentic-solid-qe`

When assisting in this repository, route your workflow through the Master Orchestrator and core lifecycle skills in `.agents/skills/`:

0. **Master Orchestrator & Incremental Coverage Advisor (`00-master-orchestrator`):**
   - Follow `.agents/skills/00-master-orchestrator/SKILL.md` and `.agents/skills/00-master-orchestrator/references/master-orchestration-playbook.md`.
   - Entry point (`/00-master-orchestrator` or `/master-orchestrator`, backed by `npx cortex orchestrate` / `npm run coverage:gaps` + `npm run migrate:skill -- --discover`) to explain all framework capabilities, diagnose current repo maturity (`Stage 0` through `Stage 4`), and recommend how the user or AI agent can incrementally increase automation coverage 1 test at a time.

1. **Environment, Auth & App Map Bootstrap (`00-env-bootstrap`):**
   - Follow `.agents/skills/00-env-bootstrap/SKILL.md`.
   - Configure `baseUrl`, capture reusable `.auth/<persona>.json` sessions for SSO/MFA apps, and discover top-level navigation shards in `.agents/domain/domain-memory.md`.

2. **Exploratory Testing, Feature Recon & Coverage Curation (`01-cli-explorer`):**
   - Follow `.agents/skills/01-cli-explorer/SKILL.md`.
   - Load context from `.agents/domain/domain-memory.md` and `.agents/domain/shards/*.md`.
   - Drive browser sessions via `npx playwright-cli -s=<name>`, map unfamiliar multi-page flows, check API/console/state/a11y heuristics, log bugs in `defects/`, present the **Session Debrief & Coverage Selection Matrix**, and output QE-selected JSON Session Tapes to `.exploratory/tapes/` matching `.agents/domain/session-tape.schema.json`.

3. **SOLID Playwright Architecture (`02-solid-architect`):**
   - Follow `.agents/skills/02-solid-architect/SKILL.md`, `.agents/skills/02-solid-architect/references/solid-patterns.md`, and `.agents/skills/02-solid-architect/references/complex-orchestration-guide.md`.
   - Compile 1 Session Tape at a time (`nextSingleScenarioToAutomate`), auditing existing classes in `src/{contracts,components,pages,data,fixtures}/` and `src/domains/<squad>/{api,components,pages,data,fixtures}/` before creating new files.
   - Enforce SRP (`*.component.ts` ≤ 150 lines, `WizardStepContract` for multi-step wizards, zero `expect()` in Pages/Components/API Clients), OCP/ISP (`test.extend` / `mergeTests` fixtures), LSP (`src/contracts/`), and DIP (`src/data/*.builder.ts` + `RelativeDateHelper`).
   - Always verify changes with `npm run verify`.

4. **Live Failure Triage & Drift Healing (`03-drift-healer`):**
   - Follow `.agents/skills/03-drift-healer/SKILL.md`.
   - Inspect failing specs against live routes via `@playwright/cli` to separate genuine application regressions (`defects/DEFECT-*.md`) from harmless UI/locator/flow drift.

5. **CI/CD Pipeline & Regression Suite Curation (`04-ci-pipeline`):**
   - Follow `.agents/skills/04-ci-pipeline/SKILL.md`.
   - Ensure specs carry `@p0`/`@smoke`/`@regression` tags and configure sharded CI/CD execution pipelines.

6. **Legacy Skill & Script Onboarding Migrator (`05-skill-migrator`):**
   - Follow `.agents/skills/05-skill-migrator/SKILL.md` and `.agents/skills/05-skill-migrator/references/migration-starter-guide.md`.
   - Run `npm run migrate:skill -- --discover` to inventory all existing rules/prompts/scripts and SOLID spec gaps across a project, then run `npm run migrate:skill -- <source-path> --name <skill-id> [--squad <squad>] [--apply]` to decompose oversized prompts and legacy helper scripts into `<500`-token `SKILL.md` bundles, secret-sanitized `references/` & `scripts/`, Session Tapes for UI scripts, and `≤ 150`-line 3-Tier Domain Brain shards.
