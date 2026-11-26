# Complex UI, Multi-Portal, API & Non-Functional Exploration

> Read on-demand when exploring conditional wizards, backend APIs, cross-portal handoffs, overlays/iframes/Shadow DOM, accessibility, or visual regression.

## 1. Wizards, Backend APIs & Cross-Portal Handoffs
- **Conditional Multi-Step Wizards (5–12 steps):** Map each section to a distinct `componentCandidate` (`VehicleLookupComponent`, `ClaimsHistoryComponent`) and record branching in `semanticSteps[].conditionRef` (e.g., `MotorRiskBuilder.withPriorClaim().hasClaims`) for `WizardStepContract<TRiskProfile>`.
- **Backend API Discovery:** Record endpoints in `networkContracts` (`clientCandidate`, `requestBuilderRef`, `responseSchemaSummary`). For API precondition seeding, use `action: "apiCall"`, `locatorContract: { strategy: "apiEndpoint", value: "/api/v1/quotes" }`, and `capturedVariables` (`source: "apiResponseJson"`, `jsonPath: "data.quoteId"`).
- **Cross-Portal Handoffs:** Declare root `actors[]` (`actorId`, `role`, `portalBaseUrl`, `dataBuilderRef`, `storageStatePath`), tag steps/assertions with `actor`, and pass IDs (`QuoteId`, `PolicyNumber`) via `capturedVariables`.

## 2. Complex UI Challenges
| UI Challenge | `agent-browser` Handling | Session Tape / SOLID Encoding |
| :--- | :--- | :--- |
| **Cookie / Promo Overlays** | Dismiss once & save `.auth/<persona>.json` (`state-save`) | Pre-seed consent in `.auth/` + `registerOverlayHandlers(page)` (`src/shared/ui/overlay-handler.ts`). No `if (visible)` checks. |
| **Native JS Dialogs** | `dialog-accept` / `dialog-dismiss` | `dialogAction: "accept"` or `"dismiss"` on triggering step. |
| **New-Tab / OAuth / PDF Popups** | `tab-list` / `tab-select <idx>` | `opensPopup: true` on triggering step (`waitForEvent('popup')`). |
| **`sr-only` Radios / Checkboxes** | Target `getByRole('radio')` / `getByLabel` | `locatorContract.force: true` (`.check({ force: true })`). |
| **Shadow DOM** | Semantic locators pierce open Shadow DOM; never XPath | Use `getByRole`/`getByLabel`/`getByTestId`; for closed Shadow DOM use host + `press`. |
| **Embedded `<iframe>`** | Inspect frame refs in snapshot | `locatorContract.iframeSelector` (`page.frameLocator(...)`). |
| **Portal Dropdowns (`body`)** | Snapshot after opening combobox | `locatorContract.portalScope: true` (roots on `page`). |

## 3. Non-Functional Charters
See `references/charter-nfr.md` for `accessibility` (`toPassAxeAudit`, `toMatchAriaSnapshot`), `performance-budget` (`toMeetPerformanceBudget`), `security-hygiene` (`toMeetSecurityHygiene`), and `visual-regression` (`toHaveScreenshot`).
