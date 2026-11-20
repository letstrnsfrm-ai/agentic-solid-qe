# Migration Triage Matrix, Guardrail Mapping & Wave Factory

> Read on-demand when presenting the 4-Part Migration Triage Matrix, checking guardrail compliance, or running multi-wave legacy migrations (`cortex wave`).

## 1. The 4-Part Migration Triage Matrix
1. **`tokenBudgetAudit`:** Original token count vs. `< 500`-tok `SKILL.md` and `≤ 800`-tok `references/*.md` budgets.
2. **`discoveredScripts` Classification:**
   - **`utility-or-api-seeder`:** Relocated to `.agents/skills/<id>/scripts/` with URLs parameterized via `process.env.BASE_URL` and secrets redacted.
   - **`legacy-ui-automation`:** Raw Playwright/Puppeteer/Cypress scripts (`waitForTimeout`, XPath, inline `expect()`) archived in `references/` and bridged into `.exploratory/tapes/<id>.json` for `02-solid-architect`.
3. **`extractedDomainKnowledge`:** Discovered `/routes` and `data-testid` quirks routed into `≤ 150`-line Domain Shards.
4. **`guardrailsEnforced`:** Secret redaction, token caps, shard indexing, and `AGENTS.md` routing registration.

## 2. Guardrail Mapping Checklist
| Legacy Anti-Pattern | `agentic-solid-qe` Standard | Gate |
| :--- | :--- | :--- |
| Monolithic prompt (`> 500` tok) | `< 500`-tok `SKILL.md` + `≤ 800`-tok `references/*.md` | `audit:solid` |
| Unindexed / `> 150`-line domain notes | Indexed Tier 0/1/2 Shard (`≤ 150` lines) + `**Last Verified:**` | `audit:solid`, `domain:graph` |
| Fragile relative path (`../seed.sh`) | `.agents/skills/<id>/scripts/seed.sh` | `05-skill-migrator` |
| Hardcoded URL or secret (`sk-*`, `ghp_*`) | `process.env.BASE_URL` + `src/data/*.builder.ts` | `audit:solid` |
| Raw UI script / `waitForTimeout` | Archived + bridged to Session Tape ➔ SOLID TS | `validate:tapes`, `audit:solid` |
| `.spec.ts` importing `@playwright/test` | Import `{ test, expect }` from `@fixtures/app.fixture` | `audit:solid` |

## 3. Large-Scale Wave Factory (`cortex wave`)
For 50–2,000 legacy tests:
```bash
npx cortex wave --scan <legacy-dir> [--squad <squad>]   # build resume-safe migration-manifest.json
npx cortex wave --scaffold-wave0 --apply                # scaffold shared Wave-0 Seeders & Flows
npx cortex wave --run --verify --batch-size 5 --workers 4
npx cortex wave --dashboard                             # render reports/migration-dashboard.html
```
