# `agent-browser` Command Reference

> **Purpose:** Zero-round-trip reference for `npx agent-browser` used by `00-env-bootstrap`, `01-cli-explorer`, and `03-drift-healer`. Always pass `--session <name>` to isolate concurrent sessions.

## 1. Session Lifecycle & CDP Attach

```bash
# Launch headed browser for exploration
npx agent-browser --session explore --headed open https://app.example.com

# Attach to paused Playwright test (`npm run test:explore`, port 9222)
npx agent-browser --session heal --cdp 9222 snapshot -i

# Close session(s)
npx agent-browser --session explore close
npx agent-browser close --all
```

## 2. Snapshot & Interaction (`@e<N>` refs)

```bash
# Interactive-only snapshot (60%+ fewer tokens)
npx agent-browser --session explore snapshot -i

# Save snapshot to .agent-browser/ for drift healing
mkdir -p .agent-browser && npx agent-browser --session heal snapshot > .agent-browser/page-heal.yml

# Interact using @e<N> refs (always re-snapshot after navigation or Shadow DOM re-renders)
npx agent-browser --session explore fill @e8 "standard_user"
npx agent-browser --session explore select @e10 "comprehensive"
npx agent-browser --session explore check @e11
npx agent-browser --session explore click @e12
npx agent-browser --session explore press Enter
```

## 3. Telemetry, Network, A11y & Auth Export

```bash
# Console errors & network requests
npx agent-browser --session explore console
npx agent-browser --session explore errors
npx agent-browser --session explore network requests --filter "/api/"

# Mock API failure (500)
npx agent-browser --session explore network route "**/api/v1/rating**" --body '{"error":"timeout"}'
npx agent-browser --session explore network unroute

# Built-in axe-core accessibility & Core Web Vitals
npx agent-browser --session explore a11y --json
npx agent-browser --session explore vitals --json

# Annotated screenshot for defect evidence
npx agent-browser --session explore screenshot defects/evidence.png --annotate

# Export Playwright-compatible storageState (.auth/<persona>.json)
node scripts/export-auth-state.mjs --session auth --out .auth/standard.json
```
