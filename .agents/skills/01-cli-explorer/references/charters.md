# Exploratory Testing Charters & Multi-Oracle Heuristics

> Read on-demand when choosing a charter or running multi-oracle checks during live `cortex explore` / `agent-browser` sessions.

## 1. Feature-Scoped Recon (Unfamiliar Multi-Page Flows)
1. Start at the entry route (or reuse `.auth/<persona>.json` from `00-env-bootstrap`).
2. Inspect pruned `-i` deltas (or `.agent-browser/page-*.yml`) at each transition to map:
   - Entry controls, wizard steps (`Step 1` ➔ `Step 2` ➔ `Confirmation`), modals/drawers, dynamic tables.
   - Runtime values generated along the flow (`OrderId`, `QuoteRef`, `CalculatedTax`) for downstream `capturedVariables`.
   - Background `GET`/`POST`/`PUT`/`DELETE` API calls for `networkContracts`.

## 2. Multi-Oracle Quality Checks (Run During Every Flow)
1. **Functional & Cross-Page State Integrity:** Verify Page 1 selections persist on review screens and survive `reload` / `go-back`.
2. **API & Network Telemetry:** Verify `2xx` within SLA; flag `5xx`, GraphQL payload errors, and unexpected unhandled console errors (`npx agent-browser --session <s_id> console error`). Distinguish expected negative-flow `4xx` (e.g., `401` on invalid login) from true server defects.
3. **Boundary & Negative Validation:** Probe `textbox`, `combobox`, `spinbutton` with empty submit, malformed inputs, and duplicate clicks.
4. **Semantic & Accessibility (a11y) Readiness:** Confirm interactive controls expose clean ARIA roles & accessible names; run `a11y --json`.

## 3. Risk-Based Prioritization Matrix & Charters
| Priority | Risk Category | Charter | Selection Criteria |
| :--- | :--- | :--- | :--- |
| **P0** | Uncovered Golden-Path Flows | `happy-path-baseline` | Core multi-page revenue/business journeys with zero `.spec.ts` coverage. |
| **P0** | Cross-Portal Handoffs | `cross-portal-handoff` | Multi-portal/multi-persona journeys (Customer ➔ Back-Office Agent). |
| **P1** | Backend API Rules & Seeding | `api-contract` | Rating, underwriting, policy, or claims APIs needing `ApiClientContract` specs/seeders. |
| **P1** | Authorization & Personas | `multi-persona-auth` | Role boundaries (Tier-1 vs. Underwriter) or unauthenticated direct route access. |
| **P1** | Form Validation & Boundaries | `boundary-analysis` | Interactive forms lacking negative/boundary validation & `ErrorBannerContract` tests. |
| **P2** | Navigation & Reload Resilience | `state-interruption` | Wizards vulnerable to reload/back-nav state loss or duplicate submission. |
| **P2** | API / 3rd-Party Faults | `chaos-network-500` | Critical 3rd-party lookups (VRM, Address, Payment) lacking graceful `5xx`/timeout fallback UI. |
