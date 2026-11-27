---
name: agentic-solid-qe
description: Autonomous single entry point for Agentic-SOLID-QE. Human gives direction and reviews; the agent executes diagnostics, test runs, coverage growth, compilation, drift healing, and CI setup via sub-skills.
---

# Skill `agentic-solid-qe`: Autonomous QE Orchestrator

> **Contract:** Human = direction & review; Agent = autonomous executor, pausing only at gates (`references/human-gates-and-reporting.md`). Never edit core `SKILL.md` for app/team rules: route app quirks ➔ `.agents/domain/` and team policies ➔ `.agents/overrides/<topic>.md` (split, never summarize).

## 1. Routing (`npx cortex orchestrate`)
1. **Auto-Start:** `--loop --compact` (diagnostics, heals, compile, waves).
2. **Context (`≤ 400` tok):** `--context [--route|--squad|--tape|--spec|--skill]`.
3. **Gates (`GATE_OPTIONS` / `gatePayload`) & Flags:**
   - **Setup:** `--bootstrap --url <url> --name "<Name>" --discover-shards` (`00-env-bootstrap`).
   - **Coverage:** `--explore <start|batch|finish|status> [--shard <id>]` (`--compile --verify`).
   - **Tapes:** `--tape <list|show|clone|patch>` (`--set-data <Builder.fn().prop=val>`).
   - **Failures:** `--heal-action <dry-run|apply> [--verify-affected]` (`03-drift-healer`).
   - **Legacy:** `npx cortex wave --run --verify --workers 4` (`05-skill-migrator`).
   - **CI & Verify:** `--ci-init` ➔ `--verify [--fast]`.
   - **Ontology:** `npx cortex ontology [--seed|--gaps|--validate]`, `impact --entity <E>|--action <A>`.
   - **Autonomous:** `--autonomous <start|loop|step|resume|status|stop|quarantine>` (`--interval`).

## 2. Lazy References (Read ONLY When Needed)
- `references/master-orchestration-playbook.md` — Stage 0–4 ladder & SOLID.
- `references/human-gates-and-reporting.md` — Gates & Blueprint.
- `references/autonomous-mode.md` — Kickoff, autopilot & intervals.
- `references/onboarding-and-upgrade.md` — `init`, `sync`, squads & legacy.
- `references/subagent-isolation.md` — Subagents & tiering.

