# High-Speed Resume, Human Codegen & Point-to-Point Segmentation

> Read on-demand when resuming mid-flow from an existing spec/checkpoint/seeder, recording a human browser flow, or splitting a long (>10-step) tape.

## 1. High-Speed Resume (`npx cortex explore`, Headless Default)
Reach Point A without replaying long UI preambles (pass `--headed` only for MFA/CAPTCHA or human observation):
```bash
# Option A — Reuse an existing spec (optionally pausing mid-test):
npx cortex explore start --from-spec tests/<point-a>.spec.ts --grep "<test>" --until-step "Submit quote" --scenario <point-b-id>

# Option B — <1s restore from saved checkpoint (cookies + storage + URL + vars):
npx cortex explore start --checkpoint <point-a-name> --scenario <point-b-id>

# Option C — Fast API Seeder for fresh mutating entities:
npx cortex explore start --from-seed scripts/seed-quote.mjs --url "https://app.example.com/quotes/{{quoteId}}" --scenario <point-b-id>
```
`app.fixture.ts` executes `holdForExplore()` (non-blocking CDP handshake in `.exploratory/live-session.json` + automatic checkpoint capture).

### Batched Exploration & 1-Command Finish
```bash
npx cortex explore batch '[["fill","@e2","user@example.com"],["click","@e5"],["assert","@e9","toContainText","Approved"]]' --step "Complete review" --scope main
npx cortex explore capture quoteId --from url --expr "quotes/([A-Z0-9-]+)"
npx cortex explore checkpoint save quote-ready
npx cortex explore actor underwriter --url "https://agent.example.com/referrals/{{quoteId}}" --auth .auth/underwriter.json
npx cortex explore finish --scenario <point-b-id> --compile --verify --emit-seeder
```
- Uses direct `node_modules/.bin/agent-browser`, reuses `domain-graph.json` component names, redacts secrets, prunes repeated rows/chrome, compiles `FlowContract`/`StateSeederContract`/`restoreCheckpoint()`, and runs targeted verification.
- *Manual fallback:* `npm run test:explore -- tests/<spec>.spec.ts` + `npx agent-browser --session explore --cdp 9222 snapshot -i`.

## 2. Human-Driven Codegen Recording
- **Fresh start:** `npx agent-browser --session record open <baseUrl> --headed` + `recording-start` (or `npx playwright codegen <baseUrl> -o .exploratory/recordings/<scenario>.ts`), finish flow, run `recording-stop`.
- **Pause mid-spec:** `npm run test:explore -- tests/<spec>.spec.ts -g "<test>"` (or `--debug` / `page.pause()`), attach via `--cdp=http://localhost:9222`, record downstream steps, then stop & detach.
- **Convert to SOLID:** `npm run migrate:skill -- .exploratory/recordings/<scenario>.ts --name <scenario> --apply` ➔ `npx cortex compile <scenario> --apply` ➔ `npm run verify:fast`.

## 3. Point-to-Point Segmentation (`resumesFrom`)
Split flows flagged by `handoffRecommendations[]` (`>=10` steps, `>=3` routes, `>=2` actors, or state-creation milestone `>=6` steps) using `resumesFrom`:
- **`api-seed` (fastest):** `seedClientRef: "<ApiClient>.<seedMethod>()"`
- **`checkpoint-state`:** `checkpointPath: ".exploratory/checkpoints/<point-a>.json"`
- **`ui-prereq`:** `specFile` + `resumeStep` for Playwright report lineage.
