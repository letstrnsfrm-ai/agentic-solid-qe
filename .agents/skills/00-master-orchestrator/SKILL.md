---
name: 00-master-orchestrator
description: Autonomous single entry point for Agentic-SOLID-QE. Human gives direction and reviews; the agent executes diagnostics, test runs, coverage growth, compilation, drift healing, and CI setup via sub-skills.
---

# Skill 00-Master: Autonomous QE Orchestrator

> **Operating Contract:** Human = **direction & review only**. Agent = **autonomous executor** via sub-skills, pausing only at human gates (`references/master-orchestration-playbook.md`).

## 1. Auto-Start & Intent-to-Skill Execution
On `/00-master-orchestrator` or any plain-language QE request:
1. Run `npm run coverage:gaps` (`npx cortex orchestrate`) and `npm run migrate:skill -- --discover`.
2. Read `.agents/domain/domain-memory.md` and `references/master-orchestration-playbook.md`.
3. Present a concise **Maturity & Execution Plan**, then **execute**:
   - **Setup/Auth:** `00-env-bootstrap` ➔ `domain:graph` *(pause only for MFA/CAPTCHA)*.
   - **Grow Coverage:** `01-cli-explorer` *(resume existing specs via `npm run test:explore` + `agent-browser --cdp 9222` to skip repeated setup)* ➔ *(human picks 1)* ➔ `02-solid-architect` ➔ `npm run verify`.
   - **Run & Fix Tests:** `playwright test` ➔ `03-drift-healer` ➔ `npm run verify` *(pause only on ambiguous bug vs. drift)*.
   - **Migrate Legacy:** `05-skill-migrator` ➔ *(human approves triage)* ➔ `02-solid-architect` ➔ `npm run verify`.
   - **CI/Release:** `04-ci-pipeline` ➔ `npm run verify`.

## 2. 5-Stage Coverage Ladder (`1 Test at a Time`)
1. **Stage 0:** `init`/`sync`, `05-skill-migrator`, `00-env-bootstrap` (`.auth/*.json`).
2. **Stage 1 (`@p0`):** `01-cli-explorer` ➔ `02-solid-architect` ➔ `verify`.
3. **Stage 2 (`@smoke`/`@regression`):** `multi-persona-auth`, `boundary-analysis`, `state-interruption`.
4. **Stage 3:** `WizardStepContract`, `ApiClientContract`, `cross-portal-handoff`.
5. **Stage 4:** `04-ci-pipeline` + continuous `03-drift-healer`.
