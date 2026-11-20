# Legacy Skill & Script Onboarding Workflow

> Read on-demand when onboarding legacy `.cursorrules`, `CLAUDE.md`, `.claude/commands`, `.github/prompts`, monolithic skills, or helper scripts (`.sh`, `.js`, `.mjs`, `.ts`, `.py`).

## 1. Target Anatomy of an Onboarded Skill
```text
.agents/
├── domain/shards/<skill-id>.md              # Extracted Domain Shard (≤ 150 lines; or domains/<squad>/shards/)
├── legacy-backups/AGENTS.legacy.md          # Pre-existing instructions backed up on init
└── skills/<skill-id>/
    ├── SKILL.md                             # Compact router (< 500 tokens)
    ├── references/legacy-reference.md       # Secret-sanitized docs & archived raw UI scripts (≤ 800 tok/file)
    └── scripts/<sanitized-helper>.mjs       # Co-located utility / API seeder scripts
.exploratory/tapes/<skill-id>.json           # Schema-valid Session Tape (when UI script bridged)
.claude/commands/<skill-id>.md & .github/prompts/<skill-id>.prompt.md
```

## 2. Phase A–D Execution Flow
- **Phase A — Safe Init:** `npx --yes github:letstrnsfrm-ai/agentic-solid-qe#v0.44.0 init . --url <url> --name "<App>"` (optional multi-squad: `npx cortex sync --squad <squad>`). Merges `package.json`/`tsconfig.json` and backs up existing `AGENTS.md`.
- **Phase B — Discover:** `npm run migrate:skill -- --discover` inventories `.cursorrules`, `.windsurfrules`, `CLAUDE.md`, `.agents/legacy-backups/*`, `.cursor/rules/*.mdc`, custom prompts/commands, oversized skills, and SOLID gaps in existing `tests/*.spec.ts`.
- **Phase C — Dry-Run Triage:** `npm run migrate:skill -- <path> --name <skill-id> [--squad <squad>]` and present the **4-Part Triage Matrix** (`references/migration-guardrails-checklist.md`).
- **Phase D — Apply & Verify:** Re-run with `--apply` (writes `<500`-tok `SKILL.md`, sanitized `references/` + `scripts/`, Session Tape bridge, indexed `≤150`-line shard, and IDE wrappers), then run `npm run verify`.
