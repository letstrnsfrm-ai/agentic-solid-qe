# Exploratory Testing Charters (`@playwright/cli`)

Use these charter playbooks when executing `01-cli-explorer`. Always run inside a named session (`-s=<charter_name>`).

---

## 1. `happy-path-baseline`
- **Goal:** Verify core business workflows end-to-end and record a baseline Session Tape for `02-solid-architect`.
- **Execution:**
  1. Authenticate using the primary persona from `domain-memory.md`.
  2. Complete the core transaction while verifying zero console errors (`npx playwright-cli -s=baseline console error`).
  3. Record all parent scopes and semantic locators into `.exploratory/tapes/<scenario>.json`.

## 2. `boundary-analysis`
- **Goal:** Probe input validation limits, empty submissions, whitespace strings, SQL/XSS payloads, and numeric boundaries.
- **Execution:**
  1. Identify all `textbox`, `spinbutton`, and `combobox` refs in `.playwright-cli/page-*.yml`.
  2. Submit empty values, max-length strings, and negative/zero quantities.
  3. Confirm inline validation banners appear and can be dismissed without page crashes.

## 3. `state-interruption`
- **Goal:** Validate session resilience across browser navigation (`back`, `reload`) and storage mutations.
- **Execution:**
  1. Progress halfway through a multi-step flow (e.g., items in cart or checkout step 1).
  2. Execute `npx playwright-cli -s=state reload` and `npx playwright-cli -s=state go-back`.
  3. Verify state persistence (e.g., cart badge count remains intact, no duplicate submissions).

## 4. `chaos-network-500`
- **Goal:** Verify graceful UI degradation when backend endpoints fail or time out.
- **Execution:**
  1. Intercept target API or asset patterns via CLI routing/network controls.
  2. Trigger the UI action and inspect `npx playwright-cli -s=chaos console error` and network logs.
  3. Ensure the application displays a user-facing fallback state rather than an unhandled white screen.

## 5. `multi-persona-auth`
- **Goal:** Verify authorization boundaries and persona-specific UI restrictions.
- **Execution:**
  1. Run parallel named sessions (`-s=standard`, `-s=locked_out`, `-s=problem`).
  2. Compare `.playwright-cli/page-*.yml` trees across personas and test direct URL navigation (`/inventory.html`) without authentication.
