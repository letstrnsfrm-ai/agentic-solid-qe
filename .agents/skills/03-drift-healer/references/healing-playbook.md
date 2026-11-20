# Live Drift Healing — 8-Way Differential Diagnosis Matrix

> Read on-demand when classifying a failing Playwright `.spec.ts` test across SPAs, conditional wizards, Back-Office portals, or Backend APIs.

Never blindly overwrite a failing selector or API payload without verifying the live app via `agent-browser`.

| # | Failure Symptom | Snapshot Observation | Console / Network | Classification | Required Action |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | `TimeoutError` waiting for locator | Control visible under renamed label, ARIA role, or parent container | `0` errors; `2xx` | **UI / Locator Drift** | Heal tape (`cortex tape patch` / `cortex heal --apply`) + Component + Shard |
| **2** | `TimeoutError` on multi-step wizard | Step added/reordered or conditional trigger changed | `0` errors; `2xx` | **Wizard Flow Drift** | Update `conditionRef` in tape + `WizardStepContract.isApplicable()` |
| **3** | API Seeder `400/422` or `undefined` var | UI works manually; `apiCall` or `jsonPath` extraction fails | Renamed JSON field or new required key | **API / Seeder Drift** | Update `networkContracts`, `jsonPath`, `ApiClientContract`, Builder |
| **4** | Redirect to `/login` or `401/403` | Protected portal/API rejects `.auth/<persona>.json` | `401`/`403` | **Expired Auth Session** | Refresh `.auth/<persona>.json` via `00-env-bootstrap` / `--project=setup` first |
| **5** | External lookup timeout (`VRM`/Payment) | Form hangs on 3rd-party spinner in UAT/Staging | `502/503/504` external host | **3rd-Party Outage** | Offer opt-in `action: "route"` (`page.route()`) fallback stub |
| **6** | Missing element or error alert on app | Expected control absent; error banner or blank screen | `500` first-party API or JS exception | **Genuine App Regression** | Log `defects/DEFECT-*.md`; keep strict `expect()` intact |
| **7** | `toHaveText` / total / rule mismatch | Premium, tax, or referral decision violates business rule | `200 OK`, wrong calculation | **Business Logic Defect** | Log `defects/DEFECT-*.md`; escalate to engineering |
| **8** | `intercepts pointer events` / hidden input | Overlay blocks click, `sr-only` radio fails, or portal/frame/Shadow DOM moved | `0` errors; `2xx` | **Overlay / Frame / Portal Drift** | Wire `registerOverlayHandlers`, set `force: true` / `portalScope: true` / `iframeSelector` |
