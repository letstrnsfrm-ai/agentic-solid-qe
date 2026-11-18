/**
 * Liskov Substitution Contract (LSP) for Composable Domain State Seeders
 * (e.g., AuthSeeder -> QuoteSeeder -> PolicySeeder for parallel MTA/Renewal/Claim tests).
 *
 * Guardrails (enforced by npm run audit:solid):
 *   - <= 150 lines per seeder (SRP)
 *   - Zero expect() calls inside src/seeders/ or src/domains/<squad>/seeders/
 *   - Prefer APIRequestContext composition (ApiClientContract + Data Builders);
 *     use UI fallback only when no backend API exists.
 */
export interface StateSeederContract<TInput = void, THandle = Record<string, unknown>> {
  seed(input?: TInput): Promise<THandle>;
  teardown?(handle: THandle): Promise<void>;
}
