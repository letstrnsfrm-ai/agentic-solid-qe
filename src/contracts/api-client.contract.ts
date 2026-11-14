import type { APIRequestContext } from '@playwright/test';

/**
 * Typed envelope returned by SOLID Backend API Clients (SRP: zero expect() inside clients).
 * Specs assert on status, latencyMs, and body using web-first/Playwright expect() calls.
 */
export interface ApiResponseEnvelope<TBody = unknown> {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Record<string, string>;
  readonly body: TBody;
}

/**
 * Liskov Substitution Contract (LSP) for Backend API Clients (Quote/Rating, Underwriting, Policy, Claims).
 */
export interface ApiClientContract {
  readonly request: APIRequestContext;
  readonly baseUrl: string;
}
