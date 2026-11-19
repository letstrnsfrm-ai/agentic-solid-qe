/**
 * Liskov Substitution Contract (LSP) for Composable Reusable UI Flows
 * (e.g., LoginFlow, CheckoutPrereqFlow for Point-A -> Point-B `ui-prereq` chaining).
 *
 * Guardrails (enforced by npm run audit:solid):
 *   - <= 150 lines per flow (SRP)
 *   - Zero expect() calls inside src/flows/ or src/domains/<squad>/flows/
 *   - Compose existing Page & Component objects; return capturedVariables for downstream specs.
 */
export interface FlowContract<TInput = void, TOutput = Record<string, string>> {
  execute(input?: TInput): Promise<TOutput>;
}
