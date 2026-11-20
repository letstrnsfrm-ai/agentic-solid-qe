# Project Onboarding, Non-Destructive Upgrades & Multi-Squad Sync

> Read on-demand when installing `agentic-solid-qe` in a repo, upgrading an existing consumer, or setting up multi-squad folders.

## 1. New Project Adoption (Non-Destructive)
```bash
npx --yes github:letstrnsfrm-ai/agentic-solid-qe#v0.25.0 init . --url <app-url> --name "<App Name>"
npx playwright install chromium
```
- Merges `package.json` scripts and `tsconfig.json` `@*` path aliases without deleting existing `src/` or `tests/`.
- Creates/merges `.gitignore` (protecting `.env`, `.auth/*.json`, `.exploratory/checkpoints/`, `test-results/`, `playwright-report/`).
- Backs up pre-existing custom `AGENTS.md` or `.github/copilot-instructions.md` to `.agents/legacy-backups/` for `/05-skill-migrator`.

## 2. Day-to-Day Consumer Upgrade (`upgrade:skills` / `cortex sync`)
```bash
npm run upgrade:skills          # or: npx cortex upgrade [--check|--diff|--apply-patches|--to <tag>]
```
- **Updated (`overwrite: true`):** `.agents/skills/**`, `.agents/domain/session-tape.schema.json`, `scripts/**`, `AGENTS.md`, `.github/copilot-instructions.md`, `.github/prompts/*`, `.claude/commands/*`. Stale removed files tracked in `.agents/framework-manifest.json` are pruned automatically (if unmodified).
- **Seeded Only If Missing (`overwrite: false`):** `src/contracts/*`, `src/shared/*`, `playwright.config.ts`, `tests/auth.setup.ts`. Config/CI updates surface safely in `.agents/upgrade-patches/`.
- **100% Preserved:** `.agents/domain/domain-memory.md`, `shards/*.md`, `domains/**`, `.exploratory/tapes/*.json`, `defects/*.md`, `references/local-overrides.md`, and all `src/` + `tests/` files.

## 3. Multi-Squad / Multi-Portal Partitioning
```bash
npx cortex sync --squad motor-b2c
npx cortex sync --squad agent-portal
```
Creates isolated `.agents/domain/domains/<squad>/` hubs/shards and `src/domains/<squad>/{api,components,pages,data,fixtures,seeders}/`.

## 4. Legacy Artifact Onboarding & Verification
1. Inventory legacy rules/prompts/scripts & SOLID gaps: `npm run migrate:skill -- --discover`
2. Dry-run & apply via `05-skill-migrator`: `npm run migrate:skill -- <path> --name <id> [--squad <squad>] [--apply]`
3. Verify all guardrails: `npm run verify`
