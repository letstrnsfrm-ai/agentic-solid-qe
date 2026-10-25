---
mode: agent
description: Diagnose failing Playwright specs against live deployed environments via @playwright/cli to separate real app defects from UI/locator drift
---
Activate `.agents/skills/03-drift-healer/SKILL.md` and execute its **Zero-Prompt Auto-Start** workflow (run failing `.spec.ts` ➔ inspect live route in `@playwright/cli --headed` against Session Tape and Domain Shard ➔ classify as Genuine App Regression [log defect] or UI/Flow Drift [heal tape, Component, and shard] ➔ run `npm run verify`).
