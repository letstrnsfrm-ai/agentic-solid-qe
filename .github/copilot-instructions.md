# GitHub Copilot Instructions — `agentic-solid-qe`

Route all Quality Engineering tasks through `.agents/skills/00-master-orchestrator/SKILL.md` (`/00-master-orchestrator`).

## Token-Efficient Execution Rules
1. **Start in 1 call:** Run `npx cortex orchestrate --loop --compact` to diagnose Stage 0–4 maturity and auto-drain safe deterministic steps.
2. **Context Packs first:** Run `npx cortex context [--route|--squad|--tape|--spec]` (`≤ 400` tok) instead of reading multiple domain/src/tape files. Use `npx cortex tape show|clone|patch` instead of raw tape JSON.
3. **Lazy-load skills & references:** Read only the active skill's `SKILL.md` (`≤ 500` tok), and open a `references/*.md` topic file (`≤ 800` tok) *only* when needed—never preload references upfront.

## Skill Map (`.agents/skills/`)
- `00-master-orchestrator/SKILL.md`: Default entry point, Smart Auto-Drain, onboarding & upgrades.
- `00-env-bootstrap/SKILL.md`: `baseUrl`, `.auth/<persona>.json`, route shard bootstrap.
- `01-cli-explorer/SKILL.md`: `cortex explore` / `agent-browser` recon, oracles, defects, Session Tapes.
- `02-solid-architect/SKILL.md`: `npx cortex compile <id> --apply` (1 test at a time; `≤ 150`-line components, zero `expect()` in `src/`, builders + fixtures + business `test.step()`).
- `03-drift-healer/SKILL.md`: `npx cortex heal` live triage (app bug ➔ `defects/` vs. healed drift).
- `04-ci-pipeline/SKILL.md`: `@p0`/`@smoke`/`@regression` tags & sharded CI pipelines.
- `05-skill-migrator/SKILL.md`: `npm run migrate:skill -- --discover` & legacy/wave onboarding.
- `agent-browser/SKILL.md`: Compact browser CLI syntax.

## Verification
Run `npm run verify:fast` during inner-loop edits and `npm run verify` once before completing any task.
