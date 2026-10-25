# Live Drift Healing & Regression Triage Playbook

Use this playbook when `03-drift-healer` investigates a failing Playwright `.spec.ts` test against a complex deployed application.

---

## 1. Differential Diagnosis Matrix (Bug vs. Drift)

Never blindly overwrite a failing test selector without checking the live application via `@playwright/cli`. Use this matrix to classify the root cause:

| Failure Symptom | `.playwright-cli/page-*.yml` Observation | Console / Network Observation | Root Cause Classification | Required Action |
| :--- | :--- | :--- | :--- | :--- |
| `TimeoutError` waiting for locator | Control is visible under a renamed label, updated ARIA role, or new parent container | `0` console errors; `2xx` API status | **UI / Locator Drift** | Update Session Tape + `src/components/*.component.ts` + Domain Shard |
| `TimeoutError` on multi-page step | Wizard added an intermediate confirmation modal or route change | `0` console errors; `2xx` API status | **Flow Drift** | Record new step in Session Tape, update Page/Component, run `npm run verify` |
| Locator missing or error banner shown | Expected element absent; error alert or blank container rendered | `4xx`/`5xx` API response or JS exception in `console error` | **Genuine App Regression** | Log `defects/DEFECT-<timestamp>.md`; preserve strict assertion in `.spec.ts` |
| `expect(locator).toHaveText()` mismatch | Dynamic price/tax/status calculation differs from business rule | `200 OK` with unexpected payload | **Business Logic Defect** | Log `defects/DEFECT-<timestamp>.md`; escalate to engineering |

---

## 2. Safe Healing Protocol (When Classified as UI / Flow Drift)

1. **Update the Source of Truth First (`.exploratory/tapes/<scenarioId>.json`):**
   - Replace the outdated `locatorContract` or step in the JSON Session Tape.
   - Run `npm run validate:tapes` to ensure no ephemeral `e14` CLI refs leaked.
2. **Heal the SOLID Component (`src/components/*.component.ts`):**
   - Update only the affected `readonly` Locator or action method while keeping the file **≤ 150 lines** and **free of `expect()`**.
3. **Update Sharded Domain Memory (`.agents/domain/shards/<feature>.md`):**
   - Document the updated locator rule or route transition so future explorations stay aligned.
4. **Run the Full Verification Gate:**
   ```bash
   npm run verify
   ```
