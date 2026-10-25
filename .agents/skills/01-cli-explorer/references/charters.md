# Exploratory Testing Charters, Multi-Oracle Heuristics & Coverage Selection Matrix (`@playwright/cli`)

Use these playbooks when executing `01-cli-explorer` on unfamiliar or complex multi-page workflows. Always run inside a named session (`-s=<charter_name>`).

---

## 0. Feature-Scoped Recon Mode (Unfamiliar Multi-Page Flows)

When a Quality Engineer asks to explore a feature they do not know end-to-end yet:
1. Start at the entry route (or reuse `.auth/<persona>.json` from `00-env-bootstrap`).
2. Inspect `.playwright-cli/page-*.yml` at each step to map the **Multi-Page State Graph**:
   - Entry controls, wizard steps (`Step 1` ➔ `Step 2` ➔ `Confirmation`), modals/drawers, and dynamic tables.
   - Dynamic runtime values generated along the flow (e.g., Order ID, Quote Reference, Calculated Tax/Total) that must be verified on downstream pages (`capturedVariables`).
   - Network/API requests (`GET`/`POST`/`PUT`/`DELETE`) triggered during page transitions (`networkContracts`).

---

## 1. Multi-Oracle Quality Checks (Executed During Exploration)

While traversing any feature flow, automatically evaluate four quality dimensions:
1. **Functional & Cross-Page State Integrity:** Do selections/inputs on Page 1 persist accurately on summary/review screens and survive `reload` / `go-back`?
2. **API & Network Integration Telemetry:** Are background requests returning `2xx` within SLA, or are `4xx`/`5xx` statuses, GraphQL payload errors, or unhandled promise rejections firing (`npx playwright-cli -s=<session> console error`)?
3. **Boundary & Negative Validation:** How do interactive forms (`textbox`, `combobox`, `spinbutton`) react to empty submissions, invalid formats, or duplicate clicks?
4. **Semantic & Accessibility (a11y) Readiness:** Do interactive controls in `.playwright-cli/page-*.yml` expose clean ARIA roles and accessible names, or are unlabeled elements creating both usability defects and automation risk?

---

## 2. Risk-Based Prioritization Matrix & Charters

| Priority | Risk Category | Target Charter | Selection Criteria |
| :--- | :--- | :--- | :--- |
| **P0 (Critical)** | Uncovered Golden Path Revenue/Core Flows | `happy-path-baseline` | Multi-page core business journeys (e.g., Checkout, Onboarding, Order Submission) with zero `.spec.ts` coverage. |
| **P1 (High)** | Authorization & Persona Boundaries | `multi-persona-auth` | Role-based access boundaries or unauthenticated direct route access. |
| **P1 (High)** | Form Validation & Edge Inputs | `boundary-analysis` | Interactive multi-step forms lacking negative/boundary validation coverage. |
| **P2 (Medium)** | Session & Navigation Resilience | `state-interruption` | Multi-page wizards vulnerable to `reload` / `go-back` state loss or duplicate submission. |
| **P2 (Medium)** | API / Asset Fault Tolerance | `chaos-network-500` | Critical API transitions lacking graceful fallback UI under `5xx`/timeout faults. |

---

## 3. Checkpoint 2: Post-Exploration Session Debrief & Coverage Selection Matrix

Once feature exploration finishes, present this structured debrief so the Quality Engineer can cherry-pick which flows become permanent CI/CD regression checks:

### A. Discovered Multi-Page Flow Map
- **Routes Traversed:** `/route-a` ➔ `/route-b` ➔ `/route-c`
- **Key Components & Dynamic State:** `<ComponentCandidates>` + `<capturedVariables>`
- **API Contracts Observed:** `<METHOD> <urlPattern> (<status>)`

### B. Defects & Observations Logged
- List any bugs written to `defects/DEFECT-<timestamp>.md` and quirks appended to `.agents/domain/shards/<feature>.md`.

### C. Candidate Regression Coverage Matrix (QE Selection)

| Option # | Priority & Tag | Candidate Scenario ID | Charter Type | Multi-Page Flow & Assertions | Recommendation |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | `@p0 @smoke` | `<feature>-e2e-happy-path` | `happy-path-baseline` | Full multi-page completion + dynamic state verification | **Must Automate (CI Gate)** |
| **2** | `@p1 @regression` | `<feature>-validation-bounds` | `boundary-analysis` | Negative/empty input guards & error banner dismissal | **Recommended** |
| **3** | `@p2 @regression` | `<feature>-state-resilience` | `state-interruption` | Mid-wizard reload/back-button state retention | **Optional / Nightly** |

Ask the engineer: *"Which candidate scenario(s) (`1`, `2`, `3`, or `all`) should I emit as Session Tapes and compile into SOLID Playwright specs via `/02-solid-architect`?"*
