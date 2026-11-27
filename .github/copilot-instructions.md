# GitHub Copilot Instructions — `agentic-solid-qe`

Route all Quality Engineering tasks through `.agents/skills/agentic-solid-qe/SKILL.md` (`/agentic-solid-qe`).

## Token-Efficient Execution Rules
1. **Single Entry Point (`npx cortex orchestrate`):** Run `--loop --compact` (or `--autonomous start|loop|resume`) to diagnose Stage 0–4 maturity, auto-drain safe steps, and surface `GATE_OPTIONS`. Route all commands via `npx cortex orchestrate` (`--bootstrap`, `--explore`, `--tape`, `--heal-action`, `--ci-init`, `--context`, `--verify`).
2. **Context Packs first:** Run `--context [--route|--squad|--tape|--spec|--skill]` (`≤ 400` tok) before file reads; use `--tape show|clone|patch`.
3. **Lazy-load skills & references:** Read only the active `SKILL.md` (`≤ 500` tok) and `references/*.md` (`≤ 800` tok) *only* when needed.
4. **Write-routing:** Never edit core `SKILL.md` for app/team rules; route app quirks ➔ `.agents/domain/` shards and team policies ➔ `.agents/overrides/<topic>.md` (`**Scope:**`, `≤ 800` tok; split, never summarize).

## Skill Map (`.agents/skills/`)
- `agentic-solid-qe/SKILL.md`: Entry point, Auto-Drain, gates, onboarding & upgrades.
- `00-env-bootstrap/SKILL.md`: `baseUrl`, `.auth/<persona>.json`, route shards (`--bootstrap --discover-shards`).
- `01-cli-explorer/SKILL.md`: `--explore` / `agent-browser` recon, oracles, defects, Tapes.
- `02-solid-architect/SKILL.md`: `--loop` / `cortex compile` (`≤ 150`L components, zero `expect()` in `src/`, builders + fixtures + `test.step()`).
- `03-drift-healer/SKILL.md`: `--heal-action dry-run|apply` live triage (bug ➔ `defects/` vs. healed drift).
- `04-ci-pipeline/SKILL.md`: `@p0`/`@smoke`/`@regression` tags & sharded CI (`--ci-init`).
- `05-skill-migrator/SKILL.md`: `npm run migrate:skill -- --discover` & legacy/wave onboarding.
- `agent-browser/SKILL.md`: Compact browser CLI syntax.

## Verification
Run `npx cortex orchestrate --verify --fast` during edits and `--verify` before completing any task.
