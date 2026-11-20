---
name: 00-master-orchestrator
description: Autonomous single entry point for Agentic-SOLID-QE. Human gives direction and reviews; the agent executes diagnostics, test runs, coverage growth, compilation, drift healing, and CI setup via sub-skills.
---

# Skill 00-Master: Autonomous QE Orchestrator

> **Contract:** Human = **direction & review**. Agent = **autonomous executor**, pausing only at human gates (`references/human-gates-and-reporting.md`).

## 1. Single-Call Auto-Start & Smart Auto-Drain
On `/00-master-orchestrator` or any plain-language QE request:
1. Run **`npx cortex orchestrate --loop --compact`** (or `--compact` read-only) to run diagnostics, high-confidence drift heals, batch compilation, and wave micro-batches in-process.
2. Run **`npx cortex context [--route|--squad|--tape|--spec]`** (`≤ 400` tok) instead of reading multiple domain/src/tape files.
3. Execute remaining interactive work via sub-skills:
   - **Setup/Auth:** `00-env-bootstrap` ➔ `domain:graph` *(pause for MFA/CAPTCHA)*.
   - **Coverage:** `01-cli-explorer` (`cortex explore start/batch/finish --compile --verify`) ➔ *(human picks 1)* ➔ `02-solid-architect` ➔ `npm run verify:fast`.
   - **Failures:** `03-drift-healer` (`npx cortex heal --apply`) ➔ `npm run verify:fast`.
   - **Legacy:** `05-skill-migrator` (`cortex wave --run --verify --workers 4`) ➔ `npm run verify`.
   - **CI:** `04-ci-pipeline` ➔ `npm run verify`.

## 2. Lazy Reference Index (Read ONLY When Needed)
- `references/master-orchestration-playbook.md` — Stage 0–4 coverage ladder, skill & SOLID contract catalog.
- `references/human-gates-and-reporting.md` — Decision flow, human gates & Master Blueprint output template.
- `references/onboarding-and-upgrade.md` — New project `init`, `upgrade:skills` / `cortex sync`, multi-squad & legacy onboarding.
- `references/subagent-isolation.md` — Optional subagent delegation & model-tiering for noisy explore/heal/migration loops (with single-agent fallback).
