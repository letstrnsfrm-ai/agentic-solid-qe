# Starter Guide: Onboarding Legacy Skills & Scripts into `agentic-solid-qe`

> **Audience:** Engineering squads (100+ engineers) migrating existing `.cursorrules`, `.claude/commands`, monolithic `SKILL.md` files, or ad-hoc helper scripts (`.sh`, `.js`, `.mjs`, `.ts`, `.py`) into the standardized `agentic-solid-qe` framework.

---

## 1. Why Unstructured Team Skills Fail at Scale

When teams build ad-hoc prompts and scripts without a shared architecture, four problems emerge:
1. **Prompt Bloat (> 2,000 tokens):** Monolithic markdown files mix workflow steps, raw code examples, and environment URLs, starving the agent's context window.
2. **Knowledge Trapped in Prompts:** Business invariants, routes, and `data-testid` quirks are buried inside individual skill prompts instead of living in the shared **3-Tier Organizational Brain** (`.agents/domain/`).
3. **Fragile Relative Script Paths:** Invocations like `bash ../scripts/seed.sh` or `node ./helper.js` fail depending on the agent's current working directory or when synced to another repository.
4. **Hardcoded URLs & UI Anti-Patterns:** Helper scripts often hardcode `https://staging.internal.app` or use brittle `waitForTimeout(5000)` / XPath selectors outside the SOLID `src/` layer.

---

## 2. Target Anatomy of an Onboarded Skill

Every migrated skill is decomposed into four clean layers:

```text
.agents/
├── domain/
│   └── domains/<squad>/shards/<feature>.md      # 1. Extracted Domain Knowledge (≤ 150 lines)
└── skills/
    └── <skill-id>/
        ├── SKILL.md                             # 2. Compact Agent Workflow (< 500 tokens)
        ├── references/
        │   └── legacy-reference.md              # 3. Heavy Templates, Payloads & Examples
        └── scripts/
            └── <sanitized-helper>.mjs           # 4. Co-located Utility / API Seeder Scripts
.claude/commands/<skill-id>.md                   # Claude Code slash command wrapper
.github/prompts/<skill-id>.prompt.md             # GitHub Copilot prompt wrapper
```

---

## 3. Step-by-Step Onboarding Workflow

### Step 1 — Run the Dry-Run Analyzer (`npm run migrate:skill`)
Point the CLI (or invoke `/05-skill-migrator <path>`) at your existing skill file or directory:

```bash
# Analyze a legacy markdown prompt or skill folder without modifying files
npm run migrate:skill -- ./legacy-team-skills/billing-seeder/ --name 06-billing-seeder --squad billing
```

The analyzer outputs a **Migration Triage Report** containing:
- `tokenBudgetAudit`: Original token count vs. the 500-token budget.
- `discoveredScripts`: Every `.sh`, `.js`, `.mjs`, `.ts`, or `.py` script referenced in the prompt or co-located in the folder.
- `classification`:
  - **`utility-or-api-seeder`**: API callers, DB seeders, token generators, or schema parsers. Safe to co-locate in `.agents/skills/<skill-id>/scripts/`.
  - **`legacy-ui-automation`**: Raw Playwright/Puppeteer/Cypress scripts containing `waitForTimeout`, XPath, or inline `expect()` calls. Flagged to convert into a **Session Tape** (`.exploratory/tapes/<scenario>.json`) and compile via `/02-solid-architect`.
- `extractedDomainKnowledge`: Discovered `/routes` and `data-testid` attributes to move into `.agents/domain/`.

### Step 2 — Apply the Scaffolding (`--apply`)
Once you review the triage report, apply the transformation:

```bash
npm run migrate:skill -- ./legacy-team-skills/billing-seeder/ --name 06-billing-seeder --squad billing --apply
```

This automatically:
1. Creates `.agents/skills/06-billing-seeder/SKILL.md` (`< 500` tokens).
2. Moves full legacy documentation and examples into `.agents/skills/06-billing-seeder/references/legacy-reference.md`.
3. Copies helper scripts into `.agents/skills/06-billing-seeder/scripts/` and parameterizes hardcoded `http(s)://` URLs with `process.env.BASE_URL`.
4. Generates `.claude/commands/06-billing-seeder.md` and `.github/prompts/06-billing-seeder.prompt.md`.

### Step 3 — Promote Domain Facts & Verify (`npm run verify`)
1. Move any business rules, API contracts, or precondition seeders from `references/legacy-reference.md` into your squad's domain shard (`.agents/domain/domains/<squad>/shards/<feature>.md`) and declare any reusable seeder script under `**Published Capabilities:**`.
2. Run the full verification gate:
   ```bash
   npm run verify
   ```

---

## 4. Script Sanitization Checklist for Squads

| Legacy Pattern | `agentic-solid-qe` Standard |
| :--- | :--- |
| `bash ../helpers/seed.sh` | `bash .agents/skills/<skill-id>/scripts/seed.sh` |
| `const url = "https://dev.myapp.com"` | `const url = process.env.BASE_URL \|\| "https://dev.myapp.com"` |
| `const secret = "sk_live_12345"` | Read from `process.env.TEST_API_SECRET` or `src/data/*.builder.ts` |
| Raw UI script with `page.waitForTimeout(3000)` | Record a Session Tape (`.exploratory/tapes/<id>.json`) and compile via `/02-solid-architect` |
