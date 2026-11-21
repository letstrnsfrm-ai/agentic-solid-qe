# Optional Subagent Isolation & Model-Tiering Guide

> Read on-demand when running noisy multi-turn exploration, drift triage, or large legacy migrations in a harness that supports subagents (e.g., Antigravity, Claude Code). Single-agent IDEs (e.g., basic Copilot) skip subagents and rely on `cortex context` + `--compact`.

## 1. Why Isolate Context?
LLM input tokens scale cumulatively with every turn ($O(N^2)$ across $N$ turns). Keeping 10–15 turns of browser snapshots, network logs, or test failure stack traces inside the main orchestrator conversation re-bills those tokens on every later compile/review turn.

## 2. Recommended Delegation Boundaries
| Workload | Main Orchestrator Keeps | Disposable Subagent Runs | Required Return Contract (≤ 120 tok) |
| :--- | :--- | :--- | :--- |
| **Live Recon (`01-cli-explorer`)** | Goal, route/squad, budget | `cortex context --route`, `cortex explore start/batch/finish`, shard update | `{ tapePath, shardPath, defectPaths[], 3-row selection matrix }` |
| **Failure Triage (`03-drift-healer`)** | Failing spec path | `cortex context --spec`, `cortex heal`, live `agent-browser` check, `verify:fast` | `{ classification, patchedFiles[] or defectPath, verifyStatus }` |
| **Legacy Scan (`05-skill-migrator`)** | Target legacy dir | `migrate:skill --discover`, `cortex wave --scan`, triage table | `{ waveSummary, topCandidates[], manifestPath }` |
| **SOLID Compile (`02-solid-architect`)** | Run directly in main (1–2 calls via `cortex compile --apply` + `verify:fast`) | Only delegate if bespoke multi-portal/wizard TypeScript authoring is required | `{ createdFiles[], updatedFiles[], verifyStatus }` |

## 3. Model-Tiering Guidelines (When Configurable)
- **Fast / Light Tier (e.g., Flash / Haiku):** Repetitive DOM exploration batches (`01-cli-explorer`), deterministic drift checks (`03-drift-healer`), legacy inventory scans (`05-skill-migrator`).
- **Standard / Reasoning Tier (e.g., Pro / Sonnet):** Master orchestration, complex Pattern A/B/C SOLID design (`02-solid-architect`), and ambiguous business-logic defect analysis.

## 4. Single-Agent Fallback (Universal)
When subagents are unavailable, preserve context hygiene by:
1. Calling `npx cortex context --route/--tape/--spec` (`≤ 400` tok) instead of reading raw files.
2. Passing `--compact` (or `CORTEX_COMPACT=1`) to all `cortex` commands.
3. Batching multi-step browser actions in one `cortex explore batch '[...]'` call instead of 1 action per turn.
