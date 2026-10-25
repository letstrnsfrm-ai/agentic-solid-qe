---
mode: agent
description: Compile recorded Session Tapes (.exploratory/tapes/*.json) into deterministic multi-page SOLID Playwright TypeScript specs
---
Activate `.agents/skills/02-solid-architect/SKILL.md` and execute its **Zero-Prompt Auto-Start** workflow (`npm run coverage:gaps` ➔ `npm run validate:tapes` ➔ audit `src/` for multi-page reuse ➔ generate SOLID Components, Pages, Fixtures, Builders, and tagged `.spec.ts` files ➔ run `npm run verify`).
