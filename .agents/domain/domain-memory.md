# Domain Memory Index (Tier 0 Org Global Context & Federated Router)

> **Scalability Rule (3-Tier Federated Brain):** Keep this Tier 0 index **≤ 150 lines (< 600 tokens)**. Store only global environment config, org personas, the **Domain Sub-Hub Index** (`.agents/domain/domains/<squad>/index.md`), and top-level Feature Shards. Machine-readable routing is compiled to `.agents/domain/domain-graph.json` via `npm run domain:graph`.

---

## 1. Global Environment & Target Application

- **Application Name:** Swag Labs (SauceDemo Reference Sandbox)
- **Base URL:** `https://www.saucedemo.com`
- **Custom Test ID Attribute:** `data-test` (`testIdAttribute: 'data-test'` in `playwright.config.ts`)
- **Session Mechanism:** Cookie `session-username` + `localStorage` key `cart-contents`

---

## 2. Global Personas (Mapped to `src/data/user.builder.ts`)

| Persona Key | Builder Method | Global Behaviour |
| :--- | :--- | :--- |
| `standard` | `UserBuilder.standardUser()` | Full access across all routes without artificial latency. |
| `locked_out` | `UserBuilder.lockedOutUser()` | Blocked at `/` with inline locked-out banner. |
| `problem` | `UserBuilder.problemUser()` | Authenticated, but exhibits UI asset and cart state defects. |
| `performance_glitch` | `UserBuilder.performanceGlitchUser()` | Authenticated, incurs 5s delay on navigation. |

---

## 3. Federated Domain & Feature Shard Index (Progressive Disclosure)

> **Agent Instruction:** Inspect `.agents/domain/domain-graph.json` or the table below to load **only** the Domain Sub-Hub (`.agents/domain/domains/<squad>/index.md`) and Feature Shard(s) matching the route or bounded context under test.

| Bounded Context / Feature | Owner Squad | Routes | Shard / Sub-Hub Path | Published Capabilities & Summary |
| :--- | :--- | :--- | :--- | :--- |
| **Authentication & Access Control** | `@org/identity-squad` | `/` | `.agents/domain/shards/auth.md` | `LoginPage`, `ErrorBannerContract`, `session-username` cookie guard. |
| **Inventory & Shopping Cart** | `@org/catalog-squad` | `/inventory.html`, `/cart.html` | `.agents/domain/shards/inventory-cart.md` | `InventoryPage`, `InventoryListComponent`, `CartListComponent`, `cart-contents` state seeder. |
| **Checkout & Order Completion** | `@org/checkout-squad` | `/checkout-step-one.html`, `/checkout-step-two.html`, `/checkout-complete.html` | `.agents/domain/shards/checkout.md` | `CheckoutPage`, `CheckoutBuilder`, tax/total invariants. |

---

## 4. Enterprise Memory Governance & Auto-Sharding Protocol

1. **Line Cap:** Tier 0 (`domain-memory.md`), Tier 1 (`domains/<squad>/index.md`), and Tier 2 (`shards/*.md`) files must not exceed **150 lines** (enforced by `npm run audit:solid`).
2. **Provenance & Ownership:** Every shard declares `**Owner Squad:**`, `**Last Verified:** YYYY-MM-DD`, and `**Published Capabilities:**` for cross-squad preconditions and `CODEOWNERS` enforcement.
3. **3-Tier Promotion:** When an organization scales beyond 10 flat shards, partition by squad under `.agents/domain/domains/<squad>/index.md` + `.agents/domain/domains/<squad>/shards/<feature>.md` and run `npm run domain:graph`.
