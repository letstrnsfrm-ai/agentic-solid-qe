---
name: agentic-solid-qe
description: Autonomous single entry point for Agentic-SOLID-QE. Human gives direction and reviews; the agent executes diagnostics, test runs, coverage growth, compilation, drift healing, and CI setup via sub-skills.
---

# Skill `agentic-solid-qe`: Autonomous QE Orchestrator

> **Contract:** Human = **direction & review**. Agent = **autonomous executor**, pausing only at human gates (`references/human-gates-and-reporting.md`).

## 1. Single-Entry-Point Routing (`npx cortex orchestrate`)
Route all commands & questions via `npx cortex orchestrate`:
1. **Auto-Start:** `npx cortex orchestrate --loop --compact` (diagnostics, drift heals, batch compilation, waves).
2. **Context (`≤ 400` tok):** `npx cortex orchestrate --context [--route|--squad|--tape|--spec]`.
3. **Structured Gates (`GATE_OPTIONS` / `gatePayload`) & Flags:**
   - **Setup/Shards:** `--bootstrap --url <url> --name "<Name>" --discover-shards` (`00-env-bootstrap`).
   - **Coverage:** `--explore <start|batch|finish|status> [--shard <id>]` (`--compile --verify`).
   - **Tapes:** `--tape <list|show|clone|patch>` (`--set-data <Builder.fn().prop=val>`).
   - **Failures:** `--heal-action <dry-run|apply> [--verify-affected]` (`03-drift-healer`).
   - **Legacy:** `npx cortex wave --run --verify --workers 4` (`05-skill-migrator`).
   - **CI & Verify:** `--ci-init` ➔ `--verify [--fast]`.
   - **Autonomous:** `--autonomous <start|loop|step|resume|status|stop|quarantine>` (`--interval`).

## 2. Lazy Reference Index (Read ONLY When Needed)
- `references/master-orchestration-playbook.md` — Stage 0–4 ladder & SOLID contracts.
- `references/human-gates-and-reporting.md` — Decision flow, gates & Blueprint template.
- `references/autonomous-mode.md` — Kickoff, objective-ranked autopilot & check-in intervals.
- `references/onboarding-and-upgrade.md` — `init`, `cortex sync`, multi-squad & legacy onboarding.
- `references/subagent-isolation.md` — Subagent delegation & model-tiering.

