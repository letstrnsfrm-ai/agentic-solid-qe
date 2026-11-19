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

## 0b. High-Speed Resume-from-Spec, API-Seed & Checkpoint Mode (Point A ➔ Point B ➔ Point C)

When Point A of a complex E2E journey requires heavy seeded data or is already automated in `tests/*.spec.ts`, use **`npx cortex explore`** (headless by default for maximum speed; pass `--headed` for MFA/CAPTCHA or human observation):

1. **Reach Point A & Auto-Attach on a Free CDP Port (Zero Spec Edits):**
   ```bash
   # Option A — Reuse an existing spec (optionally pausing mid-test after a specific test.step()):
   npx cortex explore start --from-spec tests/<point-a>.spec.ts --grep "<test title>" --until-step "Submit quote" --scenario <point-b-id>

   # Option B — Instant <1s restore from a previously saved browser checkpoint (cookies + localStorage + sessionStorage + URL + variables):
   npx cortex explore start --checkpoint <point-a-name> --scenario <point-b-id>

   # Option C — Fast API Seeder for fresh/mutating backend entities:
   npx cortex explore start --from-seed scripts/seed-quote.mjs --url "https://app.example.com/quotes/{{quoteId}}" --scenario <point-b-id>
   ```
   `app.fixture.ts` automatically executes `holdForExplore()` (non-blocking CDP handshake in `.exploratory/live-session.json` + automatic checkpoint capture) instead of blocking on Playwright Inspector.
2. **Explore Point B ➔ Point C in Batched 1-Round-Trip Calls (Auto-Recording Live Draft Tape):**
   ```bash
   npx cortex explore batch '[["fill","@e2","user@example.com"],["fill","@e3","secret"],["click","@e5"],["assert","@e9","toContainText","Approved"]]' --step "Complete underwriting review" --scope main
   npx cortex explore capture quoteId --from url --expr "quotes/([A-Z0-9-]+)"
   npx cortex explore checkpoint save quote-ready
   npx cortex explore actor underwriter --url "https://agent.example.com/referrals/{{quoteId}}" --auth .auth/underwriter.json
   ```
   Every `act`/`batch` call invokes `node_modules/.bin/agent-browser` directly (zero `npx` overhead), reuses published component names from `domain-graph.json`, resolves `@e<N>` semantic locators, auto-redacts secrets, records inline `assert` tuples into `expectedStates[]`, prunes repeated table/list rows & persistent chrome, and outputs an ultra-compact DSL (`--json` opt-in).
3. **1-Command Finalize, Release Browser, Compile, Targeted Verify & Seeder Promotion:**
   ```bash
   npx cortex explore finish --scenario <point-b-id> --compile --verify --emit-seeder
   ```
   This validates `.exploratory/tapes/<point-b-id>.json`, releases `.exploratory/live-session.release`, compiles reusable `FlowContract` / `StateSeederContract` / `restoreCheckpoint()` SOLID automation, runs targeted single-spec verification (`tsc` + `audit:solid` + compiled `.spec.ts`), and promotes observed mutating API calls (`POST`/`PUT`/`PATCH`) into a `<300ms` `StateSeederContract` when `--emit-seeder` is passed.
   *(Fallback for manual Playwright Inspector debugging: `npm run test:explore -- tests/<point-a>.spec.ts` + `npx agent-browser --session explore --cdp 9222 snapshot -i`.)*

## 0c. Human-Driven Codegen Recording Mode (Fresh Start or Pause Anywhere)

When the user prefers to click through a flow themselves in a connected browser and generate native Playwright codegen scripts before converting to SOLID automation:
1. **Option 1 — Fresh Start:**
   - Run `npx playwright-cli -s=record open <baseUrl> --headed` followed by `npx playwright-cli -s=record recording-start` (or `npx playwright codegen <baseUrl> -o .exploratory/recordings/<scenario>.ts`).
   - User completes the business flow manually in the browser, then run `npx playwright-cli -s=record recording-stop`.
2. **Option 2 — Start from Existing Spec & Pause Anywhere:**
   - Run `npm run test:explore -- tests/<spec>.spec.ts -g "<test>"` (auto-pauses after Point A), **or** run `npx playwright test tests/<spec>.spec.ts --debug` / temporary `await page.pause()` / `pause-at <file:line>` to pause at any chosen step mid-flow.
   - Attach and record from that exact state: `npx playwright-cli -s=record attach --cdp=http://localhost:9222` + `npx playwright-cli -s=record recording-start` (or click **Record** in Playwright Inspector).
   - User completes the new downstream flow from the paused point, then run `npx playwright-cli -s=record recording-stop` (and `detach`).
3. **Convert Codegen Script into SOLID Automation:**
   - Save the recorded script to `.exploratory/recordings/<scenario>.ts` and ingest it via `npm run migrate:skill -- .exploratory/recordings/<scenario>.ts --name <scenario> --apply` (or translate directly into `.exploratory/tapes/<scenario>.json` with `businessStep` and optional `resumesFrom`).
   - Validate (`npm run validate:tapes`) and compile **1 test at a time** via `/02-solid-architect <scenario>` (`npx cortex compile <scenario> --apply`) + `npm run verify` so secrets move to Data Builders, components stay `<= 150` lines, and `test.step()` uses business-domain language.

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

## 3b. Complex UI Challenges (Cookies, Popups, Dialogs, Radios, Shadow DOM, Iframes & Portals)

| UI Challenge | During `@playwright/cli` Exploration | Encode in Session Tape / Deterministic Suite |
| :--- | :--- | :--- |
| **Cookie Banners & Promo Overlays** | Dismiss once and save `.auth/<persona>.json` (`state-save`) | Pre-seed consent in `.auth/<persona>.json` + rely on `registerOverlayHandlers(page)` (`page.addLocatorHandler`) in `src/shared/ui/overlay-handler.ts`. Do not pollute business steps with `if (visible)` checks. |
| **Native JS Dialogs (`alert`/`confirm`/`prompt`)** | Run `npx playwright-cli -s=<session> dialog-accept` or `dialog-dismiss` | Set `dialogAction: "accept"` (or `"dismiss"`) on the triggering `semanticStep`. |
| **New-Tab / OAuth / PDF Popups** | Run `tab-list` / `tab-select <idx>` to inspect the popup, then switch back | Set `opensPopup: true` on the triggering `semanticStep` (compiles to `Promise.all([page.waitForEvent('popup'), ...])`). |
| **Custom / `sr-only` Radio Buttons & Checkboxes** | Target the accessible `getByRole('radio', { name })` or `getByLabel(...)` ref | If `<input>` is visually hidden behind a styled `<label>`, set `locatorContract.force: true` (compiles to `.check({ force: true })`). |
| **Shadow DOM (Open vs. Closed)** | `getByRole`/`getByLabel`/`getByTestId` pierce **open** Shadow DOM automatically; never use XPath | Record semantic locators (`getByRole`/`getByLabel`/`getByTestId`). For **closed** Shadow DOM, target the host element + keyboard navigation (`press`). |
| **Embedded `<iframe>` (e.g., Payment / 3DS)** | Inspect frame refs in `.playwright-cli/page-*.yml` | Set `locatorContract.iframeSelector` (compiles to `page.frameLocator(...)`). |
| **Portal Dropdowns (`role="listbox"` at `body`)** | Snapshot after opening the combobox to see the portal listbox outside the form | Set `locatorContract.portalScope: true` on the option step so it roots on `page` instead of `this.root`. |

---

## 3c. Non-Functional Charters: Accessibility & Visual Regression

| Charter | `@playwright/cli` Exploration Oracle | Session Tape `expectedStates[]` Encoding |
| :--- | :--- | :--- |
| **`accessibility`** | Verify landmarks (`main`, `nav`, `banner`), heading hierarchy (`h1`->`h2`), keyboard Tab order, and accessible names in `.playwright-cli/page-*.yml`. | Use `assertionType: "toMatchAriaSnapshot"` targeting the component/landmark `root` with an ARIA YAML snapshot builder ref in `expectedValueRef`. |
| **`visual-regression`** | Identify dynamic regions (timestamps, avatars, live counters) that fluctuate across runs. | Use `assertionType: "toHaveScreenshot"` with `maskSelectors: ["[data-testid='timestamp']"]` and `maxDiffPixelRatio: 0.02` (compiles with `animations: 'disabled'`). |

---

## 3d. Point-to-Point Segmentation & Handoff Recommendations

Avoid re-running huge 10+ step flows from Step 1 during exploration or CI. `npm run coverage:gaps` (`analyze-coverage.mjs`) automatically flags oversized unsegmented tapes in `handoffRecommendations[]` when any of these signals trigger:
- `semanticSteps >= 10`
- `>= 3` distinct `pageRoute` transitions
- Cross-portal / multi-actor boundary (`actors.length >= 2` or `>= 2` distinct `portalUrl`s)
- State-creation milestone (`capturesVariable`, `apiCall`, or checkout/submit/quote/policy/claim milestone) with `>= 6` total steps

When flagged (or when resuming from Point A via `npm run test:explore` + `playwright-cli attach`), emit a Point-B Session Tape with `resumesFrom`:
- **`api-seed` (Fastest):** Set `handoffStrategy: "api-seed"` and `seedClientRef: "<ApiClient>.<seedMethod>()"` to create Point-A state via `ApiClientContract` before Point-B UI steps.
- **`checkpoint-state`:** Set `handoffStrategy: "checkpoint-state"` and `checkpointPath: ".exploratory/checkpoints/<point-a-id>.json"` (gitignored) to restore saved cookies & captured variables.
- **`ui-prereq`:** Set `handoffStrategy: "ui-prereq"` with `specFile` and `resumeStep` to document Point-A ➔ Point-B lineage in Playwright reports.

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
