import type { IdentifiableComponent } from '@contracts/identifiable-component.contract';

/**
 * Liskov Substitution Contract (LSP) for Multi-Step Conditional Wizard Components
 * (e.g., Motor/Home Insurance Quote Sections: VehicleLookup, DriverHistory, ClaimsHistory, CoverOptions).
 *
 * Each step component remains <= 150 lines with zero expect() calls, and declares
 * whether it applies to a given RiskProfile Data Builder payload.
 */
export interface WizardStepContract<TRiskProfile> extends IdentifiableComponent {
  readonly stepId: string;
  isApplicable(profile: TRiskProfile): boolean;
  completeStep(profile: TRiskProfile): Promise<void>;
}
