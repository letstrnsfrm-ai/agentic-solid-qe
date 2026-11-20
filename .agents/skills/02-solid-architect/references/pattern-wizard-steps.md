# Pattern A: Conditional Multi-Step Wizards (`WizardStepContract<TRiskProfile>`)

> Read on-demand when compiling 5–12 step conditional questionnaires (e.g., Motor/Home Quote & Buy wizards).

## 1. Session Tape Step Encoding (`conditionRef`)
```json
{
  "stepIndex": 4,
  "intent": "Fill prior motor claim date when driver has claims history",
  "pageRoute": "/quote/claims-history",
  "conditionRef": "MotorRiskBuilder.driverWithPriorClaim().hasPriorClaims",
  "action": "fill",
  "inputDataRef": "MotorRiskBuilder.driverWithPriorClaim().priorClaimDate",
  "componentCandidate": "ClaimsHistoryStepComponent",
  "locatorContract": {
    "parentScope": { "strategy": "getByRole", "role": "region", "value": "Claims History" },
    "strategy": "getByLabel",
    "value": "Date of Incident"
  }
}
```

## 2. Atomic Step Component (`≤ 150` lines, Zero `expect()`)
```ts
import type { Locator, Page } from '@playwright/test';
import type { WizardStepContract } from '@contracts/wizard-step.contract';
import type { MotorRiskProfile } from '@domains/motor-b2c/data/motor-risk.builder';

export class ClaimsHistoryStepComponent implements WizardStepContract<MotorRiskProfile> {
  readonly stepId = 'claims-history';
  readonly root: Locator;
  readonly claimDateInput: Locator;
  readonly continueButton: Locator;

  constructor(page: Page) {
    this.root = page.getByRole('region', { name: 'Claims History' });
    this.claimDateInput = this.root.getByLabel('Date of Incident');
    this.continueButton = this.root.getByRole('button', { name: 'Continue' });
  }

  isApplicable(profile: MotorRiskProfile): boolean {
    return profile.hasPriorClaims && Boolean(profile.priorClaimDate);
  }

  async completeStep(profile: MotorRiskProfile): Promise<void> {
    if (profile.priorClaimDate) await this.claimDateInput.fill(profile.priorClaimDate);
    await this.continueButton.click();
  }
}
```

## 3. Wizard Page Orchestrator (Zero `expect()`)
```ts
export class MotorQuoteWizardPage {
  private readonly steps: ReadonlyArray<WizardStepContract<MotorRiskProfile>>;
  constructor(private readonly page: Page) {
    this.steps = [
      new VehicleLookupStepComponent(page),
      new DriverDetailsStepComponent(page),
      new ClaimsHistoryStepComponent(page),
      new CoverOptionsStepComponent(page),
    ];
  }
  async completeApplicableSteps(profile: MotorRiskProfile): Promise<void> {
    for (const step of this.steps) {
      if (step.isApplicable(profile)) await step.completeStep(profile);
    }
  }
}
```
Compute all dynamic dates (`policyStartDate`, `driverDob`, `priorClaimDate`) via `RelativeDateHelper` (`@shared/data/relative-date.helper`).
