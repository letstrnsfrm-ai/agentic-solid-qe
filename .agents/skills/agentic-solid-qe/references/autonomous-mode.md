# Fully Autonomous QE Mode (`--autonomous`)

> Read on-demand when the user requests **fully autonomous / autopilot** execution with periodic check-in intervals (`30m`, `1h`, `2h`, etc.).

## 1. Kickoff Intake (Narrow Objectives Once)
Ask **only missing** clarifying questions (skip anything already provided or configured):
1. **Objective & Focus:** `--focus full | baseline | regression | migrate | heal` + `--goal "<outcome>"`.
2. **Scope:** Target URL (if unconfigured), optional `--routes <csv>`, `--squad <id>`, `--target-specs <n>`.
3. **Check-In & Caps:** `--interval 30m | 1h | 2h` (default `1h`, soft-pause) + optional `--max-runtime` / `--max-cycles`.

Initialize state (`.agents/domain/autonomous-session.json`) and decision ledger (`.agents/domain/autonomous-decisions.md`):
```bash
npx cortex orchestrate --autonomous start --goal "<objective>" --focus <mode> --interval <30m|1h|2h> [--routes <csv>]
```

## 2. Continuous Skill Loop & Live Decision Output
1. Run `npx cortex orchestrate --autonomous loop` to chain deterministic steps (shard discovery, drift healing, batch tape compilation, waves, CI init) and rank `GATE_OPTIONS` against locked objectives.
2. **Stream Decisions Regularly:** Output the compact `AUTO-DECISION` block (cycle, skill, chosen option, rationale, progress, check-in countdown) after every cycle while continuing to work.
3. **Interactive Exploration:** On `action: delegate-to-agent`, execute `NEXT_COMMAND` (`01-cli-explorer`: `--explore start` ➔ `batch` ➔ `finish --compile --verify`), then immediately loop back to `--autonomous loop`.

## 3. Gate, Quarantine & Blocker Policy
- **Auto-Decide Routine Gates:** Shard discovery, scenario selection, tape cloning, waves, and CI init are ranked by `focus`, `routes`, and `goal`.
- **Log, Quarantine & Continue:** On genuine app regressions (`defects/DEFECT-*.md`), ambiguous drift (`score < 0.65`), or 3 consecutive shard failures, run `npx cortex orchestrate --autonomous quarantine --key <shard|spec> --reason "<why>" [--defect <file>]` and continue on remaining shards.
- **Hard-Pause Immediately ONLY For:** Interactive SSO / MFA / CAPTCHA / `auth-drift`, unconfigured target URL, or unreachable target app.

## 4. Check-In Intervals & Guardrails
- **Soft-Pause at Interval:** When `--interval` elapses, emit the **Progress & Decision Digest** (health delta, decisions since last check-in, defects/quarantines, next queue) and pause for user review.
- **Resume / Steer / Stop:** `--autonomous resume [--interval 2h] [--goal "<updated>"]` or `--autonomous stop`.
- **Workspace-Only:** Edit only QE workspace files (`src/`, `tests/`, `.agents/`, `defects/`, CI). Never `git push` or open PRs autonomously.
