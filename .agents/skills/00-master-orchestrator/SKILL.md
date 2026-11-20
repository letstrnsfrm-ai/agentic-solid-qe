---
name: 00-master-orchestrator
description: Autonomous single entry point for Agentic-SOLID-QE. Human gives direction and reviews; the agent executes diagnostics, test runs, coverage growth, compilation, drift healing, and CI setup via sub-skills.
---

# Skill 00-Master: Autonomous QE Orchestrator

> **Contract:** Human = **direction & review**. Agent = **autonomous executor**, pausing only at human gates (`references/master-orchestration-playbook.md`).

## 1. Single-Call Auto-Start & Smart Auto-Drain
On `/00-master-orchestrator` or any QE request:
1. Run **`npx cortex orchestrate --loop --compact`** (or `--compact` read-only) to run diagnostics, high-confidence drift heals, batch compilation, and wave micro-batches in-process.
2. Read `.agents/domain/domain-memory.md` before exploring/authoring; read `references/master-orchestration-playbook.md` *only* on-demand.
3. Execute remaining interactive work:
   - **Setup/Auth:** `00-env-bootstrap` ➔ `domain:graph` *(pause for MFA/CAPTCHA)*.
   - **Coverage:** `01-cli-explorer` (`cortex explore start/batch/finish --compile --verify`) ➔ *(human picks 1)* ➔ `02-solid-architect` ➔ `npm run verify:fast`.
   - **Failures:** `03-drift-healer` *(auto-heals high-confidence drift; pauses on bug/ambiguity)* ➔ `npm run verify:fast`.
   - **Legacy:** `05-skill-migrator` (`cortex wave --run --verify --workers 4`) ➔ `npm run verify`.
   - **CI:** `04-ci-pipeline` ➔ `npm run verify`.

## 2. 5-Stage Coverage Ladder (`Smart Auto-Drain`)
1. **Stage 0:** `init`/`sync`, `05-skill-migrator`, `00-env-bootstrap` (`.auth/*.json`).
2. **Stage 1 (`@p0`):** `01-cli-explorer` ➔ `02-solid-architect` ➔ `verify:fast` ➔ `verify`.
3. **Stage 2 (`@smoke`/`@regression`):** `multi-persona-auth`, `boundary-analysis`, `state-interruption`.
4. **Stage 3:** `WizardStepContract`, `ApiClientContract`, `cross-portal-handoff`.
5. **Stage 4:** `04-ci-pipeline` + `03-drift-healer`.
