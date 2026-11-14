---
name: 00-master-orchestrator
description: Master Orchestrator and entry-point advisor for Agentic-SOLID-QE. Diagnoses project state, explains all skills/features, recommends onboarding tracks, and guides users or AI agents through the 5-Stage Incremental Coverage Ladder. Invoke /00-master-orchestrator or /master-orchestrator anytime.
---

# Skill 00-Master: Master Orchestrator & Coverage Advisor

## 1. Zero-Prompt Auto-Start: Live Project Diagnostic
When invoked as `/00-master-orchestrator` or `/master-orchestrator`, immediately:
1. Run `npm run coverage:gaps` (`npx cortex orchestrate`) and `npm run migrate:skill -- --discover`.
2. Read `.agents/domain/domain-memory.md` and `.agents/skills/00-master-orchestrator/references/master-orchestration-playbook.md`.
3. Present the **Project Maturity & Next-Action Blueprint** (`Onboarding Track 1–4`, `coverageMaturityStage 0–4`, and exact next `/skill` or `npx cortex` command).

## 2. 5-Stage Incremental Coverage Ladder (`references/master-orchestration-playbook.md`)
Advance automation coverage **1 test at a time**:
1. **Stage 0 — Onboarding & Auth:** Run `npx cortex init` / `sync`, migrate legacy rules/scripts (`/05-skill-migrator`), and capture `.auth/<persona>.json` + route shards (`/00-env-bootstrap`).
2. **Stage 1 — P0 Baseline (`@p0`):** Explore uncovered shards via `/01-cli-explorer` (`happy-path-baseline`), compile 1 tape via `/02-solid-architect <scenario>`, and run `npm run verify`.
3. **Stage 2 — Persona & Boundary Expansion (`@smoke` / `@regression`):** Layer `multi-persona-auth`, `boundary-analysis`, `state-interruption`, and `accessibility-audit` tapes reusing SOLID components/builders.
4. **Stage 3 — Wizards, APIs & Multi-Portal:** Add `WizardStepContract`, `ApiClientContract` + `AuthTokenBridge`, and `cross-portal-handoff` flows.
5. **Stage 4 — CI/CD & Drift Healing:** Curate sharded pipelines (`/04-ci-pipeline`) and heal live drift (`/03-drift-healer`).
