# Pattern B & D: Backend API Clients, `resumesFrom` & Composable `StateSeederContract`

> Read on-demand when building `ApiClientContract` clients, `@api-contract` tests, API precondition seeders, or Point-A ➔ Point-B handoffs.

## 1. Typed API Client (`src/domains/<squad>/api/*.client.ts`, Zero `expect()`)
Reuse `.auth/<persona>.json` tokens via `AuthTokenBridge` (`@shared/api/auth-token.bridge`):
```ts
import type { APIRequestContext } from '@playwright/test';
import type { ApiClientContract, ApiResponseEnvelope } from '@contracts/api-client.contract';
import { AuthTokenBridge } from '@shared/api/auth-token.bridge';

export interface QuoteSeedResponse {
  readonly quoteId: string;
  readonly annualPremium: number;
  readonly referralRequired: boolean;
}

export class MotorQuoteApiClient implements ApiClientContract {
  constructor(
    readonly request: APIRequestContext,
    readonly baseUrl: string,
    private readonly storageStatePath?: string
  ) {}

  async createQuote<TPayload>(payload: TPayload): Promise<ApiResponseEnvelope<QuoteSeedResponse>> {
    const headers = this.storageStatePath ? AuthTokenBridge.extractAuthHeaders(this.storageStatePath) : {};
    const res = await this.request.post(`${this.baseUrl}/api/v1/quotes`, { data: payload, headers });
    return { status: res.status(), ok: res.ok(), headers: res.headers(), body: (await res.json()) as QuoteSeedResponse };
  }
}
```

## 2. API Precondition Seeding in Session Tapes (`action: "apiCall"`)
Seed Quotes/Policies in Step 1 (`locatorContract: { strategy: "apiEndpoint", value: "/api/v1/quotes" }`, `capturesVariable: "seededQuoteId"`, `capturedVariables: [{ name: "seededQuoteId", source: "apiResponseJson", jsonPath: "data.quoteId" }]`), then verify in Back-Office UI steps.

## 3. Point-to-Point Handoffs (`resumesFrom`) & Composable `StateSeederContract`
Never chain dependent `.spec.ts` files or share mutable records across Playwright workers:
```json
"resumesFrom": {
  "scenarioId": "motor-quote-part-1",
  "specFile": "tests/motor-quote-part-1.spec.ts",
  "resumeStep": "Payment and policy issuance",
  "handoffStrategy": "api-seed",
  "seedClientRef": "PolicySeeder.seedActivePolicy"
}
```
- **`StateSeederContract<TInput, THandle>`** (`src/seeders/<entity>.seeder.ts` or `src/domains/<squad>/seeders/`, `≤ 150` lines, zero `expect()`): compose API clients + unique `crypto.randomUUID()` IDs (`AuthSeeder` ➔ `QuoteSeeder` ➔ `PolicySeeder`).
- `npx cortex compile <id> --apply` wires per-test fixture auto-teardown (`try { await use(handle); } finally { await seeder.teardown?.(handle); }`) and supports `api-seed`, `checkpoint-state` (`.exploratory/checkpoints/<id>.json`), and `ui-prereq` (`FlowContract`).
