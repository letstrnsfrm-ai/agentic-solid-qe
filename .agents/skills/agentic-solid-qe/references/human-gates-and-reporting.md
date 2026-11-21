# Human Decision Gates & Master Blueprint Reporting

> Read on-demand when presenting a status Blueprint or deciding whether to auto-drain vs. pause for human review.

## 1. Precedence & Auto-Drain Decision Flow
1. **Init / Upgrade needed?** Run `init` or `npx cortex sync` (`references/onboarding-and-upgrade.md`).
2. **Legacy skills/tests discovered?** Route to `05-skill-migrator` (`cortex wave --run --verify` auto-drains safe micro-batches; pause only for wave approval or quarantined items).
3. **Missing `baseUrl` or `.auth/<persona>.json`?** Route to `00-env-bootstrap` *(pause for interactive MFA/CAPTCHA)*.
4. **Failing specs / drift artifacts?** Route to `03-drift-healer`:
   - High-confidence locator drift (`score >= 0.65`) auto-heals + runs targeted `verify:fast`.
   - Genuine app regression (`5xx`, assertion mismatch) or ambiguous drift **pauses** after logging `defects/DEFECT-*.md`.
5. **Uncompiled Session Tapes?** Auto-drain via `npx cortex compile <id> --apply` + `verify:fast` (1 test at a time or batch drain inside `--loop`).
6. **Uncovered shards / next charter?** Route to `01-cli-explorer` *(pause at Checkpoint 2 so human picks 1 scenario from the Selection Matrix)*.
7. **CI not configured?** Route to `04-ci-pipeline` *(pause for workflow review)*.

## 2. Explicit Human Gates (Only Times to Pause)
- Interactive SSO, MFA, CAPTCHA, or anti-bot challenges during `00-env-bootstrap` / `01-cli-explorer`.
- Selecting **1 scenario** from the Post-Exploration Coverage Selection Matrix (or approving a legacy migration wave).
- Reviewing a logged app regression (`defects/DEFECT-*.md`) or ambiguous low-confidence drift triage.
- Final PR / CI workflow approval.

## 3. Master Orchestrator Blueprint Template
Present this concise summary when reporting status or pausing at a gate:

```markdown
### Agentic-SOLID-QE — Master Orchestrator Blueprint
- **Target App:** `<appName>` (`<baseUrl>`) | **Track:** `<1..4>` | **Stage:** `<0..4 — Name>`
- **Health:** `<H>` Hub(s), `<M>` Shard(s) (`<U>` uncovered, `<S>` stale) | `<T>` Tapes (`<P>` uncompiled) | `<C>` Components, `<X>` Specs | `<D>` Defects
- **Agent Action:** `<Executed / executing CLI chain>`
- **Why Now:** `<1 sentence tied to current stage>`
- **Human Gate:** `<Exact decision needed, or "None — verified green">`
```
