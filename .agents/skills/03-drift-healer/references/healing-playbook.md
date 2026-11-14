# Live Drift Healing & Regression Triage Playbook

Use this playbook when `03-drift-healer` investigates a failing Playwright `.spec.ts` test across single-page apps, multi-step conditional wizards (e.g., Motor/Home Insurance), Back-Office Agent portals, and Backend APIs.

---

## 1. 7-Way Differential Diagnosis Matrix (Bug vs. Drift vs. Environment)

Never blindly overwrite a failing test selector or API payload without inspecting the live application via `@playwright/cli`. Use this matrix to classify the root cause:

| # | Failure Symptom | `.playwright-cli/page-*.yml` Observation | Console / Network Observation | Root Cause Classification | Required Action |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | `TimeoutError` waiting for locator | Control is visible under a renamed label, updated ARIA role, or new parent container | `0` console errors; `2xx` API status | **UI / Locator Drift** | Update Session Tape + `src/components/*.component.ts` + Domain Shard |
| **2** | `TimeoutError` on multi-step wizard | Questionnaire added/reordered a conditional step or changed when a sub-form appears | `0` console errors; `2xx` API status | **Conditional Wizard Flow Drift** | Update `conditionRef` in Session Tape + `WizardStepContract.isApplicable()` in step component |
| **3** | API Seeder `400/422` or `undefined` captured variable | UI works when driven manually, but `action: "apiCall"` seeder or `apiResponseJson` extraction fails | API endpoint renamed a JSON property (e.g. `quoteId` ➔ `quoteRef`) or added a required schema field | **Backend API Contract / Seeder Drift** | Update `networkContracts`, `capturedVariables[].jsonPath`, `ApiClientContract` client, and Data Builder payload |
| **4** | Immediate redirect to `/login` or `401/403` on `AuthTokenBridge` | Protected Back-Office Agent Portal or API rejects stored `.auth/<persona>.json` token | `401 Unauthorized` / `403 Forbidden` | **Expired `.auth/<persona>.json` SSO Session** | Re-run `/00-env-bootstrap` (or `npx playwright test --project=setup`) to mint a fresh `.auth/<persona>.json` before touching code |
| **5** | External lookup timeout (`VRM`, `Postcode`, `Credit`, `Payment`) | Form hangs on 3rd-party lookup spinner in UAT/Staging | `502/503/504` from external 3rd-party sandbox domain | **3rd-Party Sandbox Outage** | Offer engineer opt-in `action: "route"` (`page.route()`) fallback stub for the flaky 3rd-party endpoint |
| **6** | Locator missing or error banner shown on first-party app | Expected element absent; error alert or blank container rendered | `500` first-party API error or unhandled JS exception in `console error` | **Genuine App Regression** | Log `defects/DEFECT-<timestamp>.md`; preserve strict assertion in `.spec.ts` |
| **7** | `expect(locator).toHaveText()` or API status/total mismatch | Dynamic premium/tax/underwriting referral decision differs from business rule | `200 OK` with unexpected business calculation | **Business Logic Defect** | Log `defects/DEFECT-<timestamp>.md`; escalate to engineering |

---

## 2. Safe Healing Protocol (When Classified as Drift #1, #2, #3, #4, or #5)

1. **Refresh Expired Auth First (If #4):**
   - If `.auth/<persona>.json` expired, invoke `/00-env-bootstrap` to refresh the storageState file and re-run the failing spec before editing any TypeScript or Session Tape files.
2. **Update the Source of Truth (`.exploratory/tapes/<scenarioId>.json`):**
   - Replace the outdated `locatorContract`, `conditionRef`, `capturedVariables[].jsonPath`, or `networkContracts` entry in the JSON Session Tape.
   - Run `npm run validate:tapes` to ensure schema compliance and confirm no ephemeral `e14` CLI refs leaked.
3. **Heal the SOLID Layer (`src/`):**
   - **UI / Wizard Component (`src/components/` or `src/domains/<squad>/components/`):** Keep every component **≤ 150 lines** and **free of `expect()`**.
   - **Backend API Client (`src/domains/<squad>/api/*.client.ts`):** Keep API clients **free of `expect()`** and implementing `ApiClientContract`.
4. **Update Sharded Domain Memory (`.agents/domain/shards/*.md` or `.agents/domain/domains/<squad>/shards/*.md`):**
   - Record the updated locator, wizard condition, or API schema and update `**Last Verified:** YYYY-MM-DD`.
5. **Run the Full Verification Gate:**
   ```bash
   npm run verify
   ```
