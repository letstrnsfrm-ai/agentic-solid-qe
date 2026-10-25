---
mode: agent
description: Bootstrap target environment URL, capture reusable persona storageState auth sessions, and map top-level routes for an unfamiliar deployed application
---
Activate `.agents/skills/00-env-bootstrap/SKILL.md` and execute its **Zero-Prompt Auto-Start** workflow (`npm run coverage:gaps` ➔ configure Base URL / personas in `.agents/domain/domain-memory.md` ➔ capture authenticated `.auth/<persona>.json` session via `@playwright/cli --headed` ➔ discover top-level navigation shards ➔ offer handoff to `01-cli-explorer`).
