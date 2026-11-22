# GitHub Copilot Instructions — `agentic-solid-qe`

Route all Quality Engineering tasks through `.agents/skills/agentic-solid-qe/SKILL.md` (`/agentic-solid-qe`).

## Token-Efficient Execution Rules
1. **Single Entry Point (`npx cortex orchestrate`):** Run `npx cortex orchestrate --loop --compact` (or `--autonomous start|loop|resume` for interval-based autopilot) to diagnose Stage 0–4 maturity, auto-drain safe steps, and surface structured gates (`GATE_OPTIONS`). Route all commands via `npx cortex orchestrate` (`--bootstrap`, `--explore`, `--tape`, `--heal-action`, `--ci-init`, `--context`, `--verify`).
2. **Context Packs first:** Run `npx cortex orchestrate --context [--route|--squad|--tape|--spec]` (`≤ 400` tok) before reading files. Use `orchestrate --tape show|clone|patch` (`--set-data`) instead of raw tape JSON.
3. **Lazy-load skills & references:** Read only the active `SKILL.md` (`≤ 500` tok) and open `references/*.md` (`≤ 800` tok) *only* when needed.

## Skill Map (`.agents/skills/`)
- `agentic-solid-qe/SKILL.md`: Unified entry point, Smart Auto-Drain, structured gates, onboarding & upgrades.
- `00-env-bootstrap/SKILL.md`: `baseUrl`, `.auth/<persona>.json`, route shards (`--bootstrap --discover-shards`).
- `01-cli-explorer/SKILL.md`: `--explore` / `agent-browser` recon, oracles, defects, Session Tapes.
- `02-solid-architect/SKILL.md`: `--loop` / `cortex compile <id> --apply` (`≤ 150`-line components, zero `expect()` in `src/`, builders + fixtures + `test.step()`).
- `03-drift-healer/SKILL.md`: `--heal-action dry-run|apply` live triage (app bug ➔ `defects/` vs. healed drift).
- `04-ci-pipeline/SKILL.md`: `@p0`/`@smoke`/`@regression` tags & sharded CI (`--ci-init`).
- `05-skill-migrator/SKILL.md`: `npm run migrate:skill -- --discover` & legacy/wave onboarding.
- `agent-browser/SKILL.md`: Compact browser CLI syntax.

## Verification
Run `npx cortex orchestrate --verify --fast` during inner-loop edits and `npx cortex orchestrate --verify` before completing any task.
