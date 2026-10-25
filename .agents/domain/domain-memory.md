# Domain Memory Index (Global Context & Shard Router)

> **Scalability Rule (Hub-and-Spoke):** Keep this index file **≤ 150 lines (< 600 tokens)**. Store only global environment config, personas, and the **Feature Shard Index**. Load and append feature-specific rules and discovered quirks inside `.agents/domain/shards/<feature>.md`.

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

## 3. Feature Shard Index (Progressive Disclosure)

> **Agent Instruction:** Read **only** the shard(s) matching the route or feature under test. When discovering new behaviours, append them to the matching shard (or create a new `.agents/domain/shards/<feature>.md` ≤ 150 lines and register it below).

| Feature / Domain Area | Routes | Shard Path | Summary |
| :--- | :--- | :--- | :--- |
| **Authentication & Access Control** | `/` | `.agents/domain/shards/auth.md` | Login form locators, error banner rules, unauthenticated route guards. |
| **Inventory & Shopping Cart** | `/inventory.html`, `/cart.html` | `.agents/domain/shards/inventory-cart.md` | 6-item catalog, card parent-scoping rules, sorting, cart badge sync. |
| **Checkout & Order Completion** | `/checkout-step-one.html`, `/checkout-step-two.html`, `/checkout-complete.html` | `.agents/domain/shards/checkout.md` | Customer info form, tax/total calculation overview, order confirmation. |

---

## 4. Memory Hygiene & Auto-Sharding Protocol

1. **Line Cap:** Neither `domain-memory.md` nor any `.agents/domain/shards/*.md` file may exceed **150 lines** (enforced by `npm run audit:solid`).
2. **Deduplication & Compaction:** Before appending to a shard, merge duplicate observations and remove outdated quirks.
3. **Auto-Splitting:** When a shard exceeds 120 lines, split it into sub-domain shards (e.g., `checkout-shipping.md`, `checkout-payment.md`) and update the table in Section 3.
