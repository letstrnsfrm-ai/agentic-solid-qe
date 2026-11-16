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

## 0b. Resume-from-Spec Exploration Mode (Point A ➔ Point B ➔ Point C)

When Point A of an E2E journey is already automated in `tests/*.spec.ts` (for example, login, quote creation, or cart setup) and you want to explore downstream **Point B ➔ Point C** business scenarios without manually replaying Point A:
1. **Run Point A and Pause Automatically (Zero Spec Edits):**
   ```bash
   npm run test:explore -- tests/<point-a>.spec.ts -g "<test title>"
   ```
   `npm run test:explore` sets `PW_PAUSE_FOR_EXPLORE=1` (triggering `await page.pause()` in `src/fixtures/app.fixture.ts` after the test's automated steps finish) and `EXPLORE_CDP_PORT=9222` (non-CI only).
   - *Alternative (`--debug=cli`):* Run `npx playwright test tests/<point-a>.spec.ts -g "<test title>" --debug=cli` (or place a temporary `await page.pause()` at a specific `test.step()`).
2. **Attach `@playwright/cli` to the Paused Browser at Point A:**
   ```bash
   npx playwright-cli -s=explore attach --cdp=http://localhost:9222
   # Or, when launched with --debug=cli:
   npx playwright-cli -s=explore attach
   ```
3. **Explore Point B ➔ Point C Live:**
   - Run `npx playwright-cli -s=explore snapshot --filename=.playwright-cli/page-point-a.yml` and continue traversing Point B and Point C (`click`, `fill`, `console error`, `snapshot`).
   - When done, detach cleanly (`npx playwright-cli -s=explore detach`) without killing the test runner, or press Resume in the Playwright Inspector.
4. **Emit or Extend the Session Tape:**
   - **Linear E2E Expansion:** Append the newly discovered `B ➔ C` `semanticSteps`, `networkContracts`, and `expectedStates` to the existing parent `.exploratory/tapes/<scenario>.json` and recompile with `npx cortex compile <scenario> --apply --force-spec`.
   - **Downstream Branching Scenario:** Emit a new `.exploratory/tapes/<downstream-scenario>.json` with `resumesFrom: { scenarioId, specFile, resumeStep }` so `/02-solid-architect` reuses Point A's existing Page/Component classes.

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
| **P0 (Critical)** | Uncovered Golden Path Revenue/Core Flows | `happy-path-baseline` | Multi-page core business journeys (e.g., Motor/Home Quote & Bind, Checkout, Order Submission) with zero `.spec.ts` coverage. |
| **P0 (Critical)** | Cross-Portal Business Handoffs | `cross-portal-handoff` | Journeys spanning multiple portals/personas (e.g., Customer Quote triggers underwriting referral ➔ Back-Office Agent approves & binds policy). |
| **P1 (High)** | Backend API Business Rules & Seeding | `api-contract` | Core backend API endpoints (Rating Engine, Underwriting, Policy Issuance, Claims) explored to build typed `APIRequestContext` clients and contract specs. |
| **P1 (High)** | Authorization & Persona Boundaries | `multi-persona-auth` | Role-based access boundaries (e.g., Tier 1 Agent vs. Senior Underwriter) or unauthenticated direct route access. |
| **P1 (High)** | Form Validation & Edge Inputs | `boundary-analysis` | Interactive multi-step forms lacking negative/boundary validation coverage. |
| **P2 (Medium)** | Session & Navigation Resilience | `state-interruption` | Multi-page wizards vulnerable to `reload` / `go-back` state loss or duplicate submission. |
| **P2 (Medium)** | API / 3rd-Party Fault Tolerance | `chaos-network-500` | Critical API transitions or 3rd-party lookups (VRM, Address, Credit, Payment) lacking graceful fallback UI under `5xx`/timeout faults. |

---

## 3. Multi-Step Conditional Wizards, Cross-Portal Handoffs & Backend API Recon

1. **Conditional Multi-Step Wizards (e.g., 5–12 Step Motor/Home Insurance Flows):**
   - Treat each wizard section as a distinct `componentCandidate` (`VehicleLookupComponent`, `DriverHistoryComponent`, `ClaimsHistoryComponent`, `CoverOptionsComponent`).
   - Record conditional branching rules in `semanticSteps[].conditionRef` (e.g., `MotorRiskBuilder.withPriorClaim().hasClaims`) so `/02-solid-architect` compiles a `WizardStepContract<TRiskProfile>` orchestrator.
2. **Backend API Discovery & Schema Capture:**
   - Record observed backend API endpoints in `networkContracts` with `clientCandidate` (e.g., `MotorQuoteApiClient`), `requestBuilderRef`, and `responseSchemaSummary` (e.g., `{ quoteId, annualPremium, referralRequired }`).
   - When a test seeds state via API (e.g., creating a referred Quote via API before testing the Back-Office Agent Portal UI), use `action: "apiCall"`, `locatorContract: { strategy: "apiEndpoint", value: "/api/v1/quotes" }`, and `capturedVariables` with `source: "apiResponseJson"` and `jsonPath: "data.quoteId"`.
3. **Cross-Portal Handoffs (Customer Portal ➔ Back-Office Agent Portal):**
   - Declare each participating portal and persona in root `actors` (`actorId`, `role`, `portalBaseUrl`, `dataBuilderRef`, `storageStatePath`).
   - Tag each step in `semanticSteps` and assertion in `expectedStates` with `actor` (e.g., `"customer"` vs. `"underwriter_agent"`) and pass runtime identifiers (`QuoteId`, `PolicyNumber`) across portals via `capturedVariables`.

---

## 4. Checkpoint 2: Post-Exploration Session Debrief & 1-Test-at-a-Time Selection Matrix

Once feature exploration finishes, present this structured debrief so the Quality Engineer selects **1 critical scenario at a time** to compile and stabilize before moving to the next:

### A. Discovered Multi-Page / Multi-Portal Flow & Backend API Map
- **Portals & Routes Traversed:** `<Portal A: /route-1 -> /route-2>` ➔ `<Portal B: /agent/referrals>`
- **Key Components & Dynamic State:** `<ComponentCandidates>` + `<capturedVariables>`
- **Backend API Contracts Observed:** `<METHOD> <urlPattern> (<status>) -> <clientCandidate> <responseSchemaSummary>`

### B. Defects & Observations Logged
- List any bugs written to `defects/DEFECT-<timestamp>.md` and rules appended to `.agents/domain/shards/<feature>.md` (or `.agents/domain/domains/<squad>/shards/<feature>.md`).

### C. Candidate Regression Coverage Matrix (Strict 1-Test-at-a-Time Pacing)

| Option # | Priority & Tag | Candidate Scenario ID | Charter Type | Flow / API Scope & Assertions | Recommendation |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | `@p0 @smoke` | `<feature>-e2e-happy-path` | `happy-path-baseline` | Full multi-step completion + dynamic state verification | **Automate 1st (CI Gate)** |
| **2** | `@p0 @smoke` | `<feature>-cross-portal-referral` | `cross-portal-handoff` | Customer quote referral + Agent Portal underwriting approval | **Automate 2nd** |
| **3** | `@p1 @regression` | `<feature>-api-contract` | `api-contract` | Backend API rating/issuance contract & precondition seeder | **Automate 3rd** |
| **4** | `@p1 @regression` | `<feature>-validation-bounds` | `boundary-analysis` | Negative/boundary input guards & error banner dismissal | **Automate 4th** |

Ask the engineer: *"To build a rock-solid pack 1 test at a time, which **single candidate scenario** (`1`, `2`, `3`, or `4`) should I emit as a Session Tape and compile/verify first via `/02-solid-architect <scenario-id>`?"*
