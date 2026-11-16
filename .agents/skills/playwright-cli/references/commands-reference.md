# `@playwright/cli` Complete Command & Workflow Reference

> **Purpose:** Zero-round-trip reference for `npx playwright-cli` (`@playwright/cli`) used by `00-env-bootstrap`, `01-cli-explorer`, and `03-drift-healer`. Always pass `-s=<session>` to isolate concurrent sessions.

---

## 1. Sessions, Launch & Attach / Detach

```bash
# Launch a fresh headed browser session
npx playwright-cli -s=explore open https://app.example.com --headed
npx playwright-cli -s=explore open https://app.example.com --headed --browser=chromium

# Attach to a test paused via `npm run test:explore` (EXPLORE_CDP_PORT=9222)
npx playwright-cli -s=explore attach --cdp=http://localhost:9222

# Attach to a test paused via `npx playwright test --debug=cli`
npx playwright-cli -s=explore attach

# Attach to a local Chrome/Edge channel with remote debugging enabled
npx playwright-cli -s=explore attach --cdp=chrome
npx playwright-cli -s=explore attach --extension

# Detach cleanly without killing the external test/browser
npx playwright-cli -s=explore detach

# List or close sessions
npx playwright-cli list
npx playwright-cli -s=explore close
npx playwright-cli close-all
```

---

## 2. Snapshots & Element Refs

Every state-changing command prints the current URL/title and a path to `.playwright-cli/page-*.yml`. Always inspect the latest snapshot before using an `e<N>` ref.

```bash
# Capture an explicit named snapshot
npx playwright-cli -s=explore snapshot --filename=.playwright-cli/page-step.yml

# Search snapshot text/regex
npx playwright-cli -s=explore find "Checkout"
```

---

## 3. Navigation & Element Interactions

```bash
npx playwright-cli -s=explore goto https://app.example.com/cart
npx playwright-cli -s=explore go-back
npx playwright-cli -s=explore go-forward
npx playwright-cli -s=explore reload

npx playwright-cli -s=explore fill e12 "standard_user"
npx playwright-cli -s=explore click e14
npx playwright-cli -s=explore dblclick e14
npx playwright-cli -s=explore hover e18
npx playwright-cli -s=explore select e20 "comprehensive"
npx playwright-cli -s=explore check e22
npx playwright-cli -s=explore uncheck e22
npx playwright-cli -s=explore press Enter
npx playwright-cli -s=explore upload e25 ./fixtures/sample.pdf
```

---

## 4. Tabs & Dialogs

```bash
npx playwright-cli -s=explore tab-list
npx playwright-cli -s=explore tab-new https://agent.example.com
npx playwright-cli -s=explore tab-select 1
npx playwright-cli -s=explore tab-close 1

npx playwright-cli -s=explore dialog-accept
npx playwright-cli -s=explore dialog-dismiss
```

---

## 5. Telemetry, Network Mocking & Storage State

```bash
# Evaluate JS in the active page
npx playwright-cli -s=explore eval "() => location.href"

# Inspect console & network telemetry
npx playwright-cli -s=explore console
npx playwright-cli -s=explore console error
npx playwright-cli -s=explore network

# Mock / fault-inject backend endpoints
npx playwright-cli -s=explore route "**/api/v1/rating**" --status=500 --body='{"error":"timeout"}'
npx playwright-cli -s=explore unroute

# Save & restore Playwright storageState (.auth/<persona>.json)
npx playwright-cli -s=auth state-save .auth/standard.json
npx playwright-cli -s=explore state-load .auth/standard.json
```

---

## 6. Evidence Capture (Screenshots & Traces)

```bash
npx playwright-cli -s=explore screenshot --filename=defects/evidence.png
npx playwright-cli -s=explore tracing-start
npx playwright-cli -s=explore tracing-stop
```

---

## 7. Human-Driven Codegen Recording & Pause-Anywhere Debugging

```bash
# Record human browser actions into native Playwright TypeScript code
npx playwright-cli -s=record recording-start
# ... user completes the flow in the connected browser ...
npx playwright-cli -s=record recording-stop

# Or launch Playwright's standalone codegen recorder for a fresh start
npx playwright codegen https://app.example.com -o .exploratory/recordings/new-flow.ts

# Pause a test at any file:line during --debug=cli
npx playwright-cli -s=record pause-at tests/e2e-checkout.spec.ts:24
npx playwright-cli -s=record resume
npx playwright-cli -s=record step-over
```

