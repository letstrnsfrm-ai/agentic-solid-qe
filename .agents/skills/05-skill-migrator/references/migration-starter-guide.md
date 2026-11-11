# Starter Guide: AI-Guided Project Onboarding & Legacy Skill Migration (`agentic-solid-qe`)

> **Audience:** Engineering squads (1 to 100+ engineers) and their IDE AI Agents (Antigravity, Claude Code, GitHub Copilot, Cursor, Windsurf) installing `agentic-solid-qe` into existing repositories and migrating legacy `.cursorrules`, `.claude/commands`, `CLAUDE.md`, `.github/prompts`, monolithic `SKILL.md` files, and helper scripts (`.sh`, `.js`, `.mjs`, `.ts`, `.py`).

---

## 1. Why Unstructured Team Skills Fail at Scale

When teams build ad-hoc prompts and scripts without a shared architecture, four problems emerge:
1. **Prompt Bloat (> 2,000 tokens):** Monolithic markdown files mix workflow steps, raw code examples, and environment URLs, starving the agent's context window.
2. **Knowledge Trapped in Prompts:** Business invariants, routes, and `data-testid` quirks are buried inside individual skill prompts instead of living in the shared **3-Tier Organizational Brain** (`.agents/domain/`).
3. **Fragile Relative Script Paths:** Invocations like `bash ../scripts/seed.sh` or `node ./helper.js` fail depending on the agent's current working directory or when synced to another repository.
4. **Hardcoded URLs, Secrets & UI Anti-Patterns:** Helper scripts often hardcode `https://staging.internal.app`, leak API keys (`sk-*`, `ghp_*`), or use brittle `waitForTimeout(5000)` / XPath selectors outside the SOLID `src/` layer.

---

## 2. Target Anatomy of an Onboarded Skill

Every migrated skill is decomposed into clean, guardrail-verified layers:

```text
.agents/
├── domain/
│   ├── domain-memory.md                         # Tier 0 Root Index (≤ 150 lines)
│   └── shards/<skill-id>.md                     # 1. Extracted Domain Shard (≤ 150 lines)
│       (or domains/<squad>/shards/<skill-id>.md)
├── legacy-backups/
│   └── AGENTS.legacy.md                         # Pre-existing custom instructions backed up on init
└── skills/
    └── <skill-id>/
        ├── SKILL.md                             # 2. Compact Agent Workflow (< 500 tokens)
        ├── references/
        │   ├── legacy-reference.md              # 3. Secret-Sanitized Legacy Docs & Templates
        │   └── <archived-ui-script>.js          #    Archived raw UI scripts (bridged to Session Tape)
        └── scripts/
            └── <sanitized-helper>.mjs           # 4. Co-located Utility / API Seeder Scripts
.exploratory/tapes/<skill-id>.json               # 5. Schema-valid Session Tape (when UI script bridged)
.claude/commands/<skill-id>.md                   # Claude Code slash command wrapper
.github/prompts/<skill-id>.prompt.md             # GitHub Copilot prompt wrapper
AGENTS.md                                        # Registered in Universal Skill Routing Table
```

---

## 3. End-to-End AI-Agent Onboarding & Migration Workflow

### Phase A — Safe Installation in an Existing Project
Run in the root of the existing repository:
```bash
npx --yes github:letstrnsfrm-ai/agentic-solid-qe init . --url https://your-app-url.com --name "Your App"
```
- **Non-Destructive Merge:** Merges `package.json` scripts and `tsconfig.json` `@*` path aliases without deleting existing `src/` or `tests/`.
- **Automatic Instruction Backup:** If your repo already had a custom `AGENTS.md` or `.github/copilot-instructions.md`, `init` backs them up to `.agents/legacy-backups/` so `/05-skill-migrator` can migrate them cleanly.
- **Multi-Squad Option:** For 100+ engineer monorepos, scaffold squad-isolated folders via:
  ```bash
  npx cortex sync --squad <squad-name>
  ```

### Phase B — Workspace Discovery (`--discover`)
Scan the repository for all legacy rules, prompts, skills, helper scripts, and non-SOLID Playwright specs:
```bash
npm run migrate:skill -- --discover
```
The discovery JSON report inventories:
- `discoveredLegacySkillsAndPrompts`: Detects `.cursorrules`, `.windsurfrules`, `CLAUDE.md`, `.agents/legacy-backups/*.md`, `.cursor/rules/*.mdc`, custom `.claude/commands/*.md`, `.github/prompts/*.md`, `.github/instructions/*.md`, and oversized/unregistered skills in `.agents/skills/`, complete with suggested `--name` IDs and ready-to-run commands.
- `existingPlaywrightSuiteAudit`: Scans existing `tests/*.spec.ts` (and `e2e/*.spec.ts`) for SOLID guardrail gaps (direct `@playwright/test` imports instead of `@fixtures/app.fixture`, missing `@data/` Data Builders, hardcoded URLs).

### Phase C — Dry-Run Triage for Each Skill
```bash
npm run migrate:skill -- ./path/to/legacy-skill-or-folder --name 06-billing-seeder --squad billing
```
Present the **4-Part Migration Triage Matrix** to the user:
1. `tokenBudgetAudit`: Original token count vs. the `< 500`-token `SKILL.md` budget.
2. `discoveredScripts` & Classification:
   - **`utility-or-api-seeder`**: API callers, DB seeders, token generators. Relocated to `.agents/skills/<skill-id>/scripts/` with URLs parameterized via `process.env.BASE_URL` and secrets redacted.
   - **`legacy-ui-automation`**: Raw Playwright/Puppeteer/Cypress scripts containing `waitForTimeout`, XPath, or inline `expect()`. Archived in `.agents/skills/<skill-id>/references/` and bridged into a schema-valid **Session Tape** (`.exploratory/tapes/<skill-id>.json`) for `/02-solid-architect`.
3. `extractedDomainKnowledge`: Discovered `/routes` and `data-testid` attributes slated for `.agents/domain/`.
4. `guardrailsEnforced`: Confirms secret redaction, `< 500`-token budget, `≤ 150`-line shard indexing, and `AGENTS.md` routing registration.

### Phase D — Apply & Verify (`--apply` + `npm run verify`)
```bash
npm run migrate:skill -- ./path/to/legacy-skill-or-folder --name 06-billing-seeder --squad billing --apply
npm run verify
```
When `--apply` runs, it automatically:
1. Writes `.agents/skills/<skill-id>/SKILL.md` (`< 500` tokens).
2. Writes secret-sanitized `.agents/skills/<skill-id>/references/legacy-reference.md`.
3. Copies & sanitizes `utility-or-api-seeder` scripts into `.agents/skills/<skill-id>/scripts/`.
4. Archives `legacy-ui-automation` scripts in `references/` and scaffolds `.exploratory/tapes/<skill-id>.json`.
5. Scaffolds and indexes the `≤ 150`-line Domain Shard in `.agents/domain/shards/<skill-id>.md` (or `.agents/domain/domains/<squad>/shards/<skill-id>.md` + Tier 1 Squad Sub-Hub).
6. Registers `<skill-id>` in `AGENTS.md` and `.github/copilot-instructions.md`, and creates `.claude/commands/<skill-id>.md` and `.github/prompts/<skill-id>.prompt.md`.

---

## 4. Guardrail Mapping Checklist

| Legacy Pattern | `agentic-solid-qe` Guardrail Standard | Enforced By |
| :--- | :--- | :--- |
| Monolithic prompt (`> 500` tokens) | `< 500`-token `SKILL.md` + `references/legacy-reference.md` | `npm run audit:solid` |
| Unindexed or `> 150`-line domain notes | Indexed Tier 0/1/2 Domain Shard (`≤ 150` lines) + `**Last Verified:**` | `npm run audit:solid` & `npm run domain:graph` |
| `bash ../helpers/seed.sh` | `bash .agents/skills/<skill-id>/scripts/seed.sh` | `05-skill-migrator` |
| `const url = "https://dev.myapp.com"` | `(process.env.BASE_URL \|\| "https://dev.myapp.com")` | `05-skill-migrator` & `npm run audit:solid` |
| Hardcoded secrets (`sk-*`, `ghp_*`, `password = "..."`) | Redacted in `references/` & `scripts/`; read from `process.env` / `src/data/*.builder.ts` | `05-skill-migrator` & `npm run audit:solid` |
| Raw UI script with `waitForTimeout(3000)` | Archived in `references/`, bridged to `.exploratory/tapes/<id>.json`, compiled via `/02-solid-architect` | `npm run validate:tapes` & `npm run audit:solid` |
| Existing `.spec.ts` importing `@playwright/test` | Import `{ test, expect }` from `@fixtures/app.fixture` and builders from `@data/*` | `npm run audit:solid` |
