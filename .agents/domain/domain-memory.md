# Domain Memory: Application Context & Living Heuristics

> **Purpose:** This file is read by `01-cli-explorer` before opening a browser session and by `02-solid-architect` before scaffolding TypeScript classes. Engineers can edit this file in plain English at any time; agents automatically append newly discovered quirks under `## Discovered Behaviours`.

---

## 1. Environment & Target Application

- **Application Name:** Swag Labs (SauceDemo Reference Sandbox)
- **Base URL:** `https://www.saucedemo.com`
- **Custom Test ID Attribute:** `data-test` (configured in `playwright.config.ts` via `testIdAttribute: 'data-test'`)
- **Authentication Mechanism:** Client-side session cookie (`session-username`) + `localStorage` cart state (`cart-contents`).

---

## 2. Personas & Credentials (Mapped to `src/data/user.builder.ts`)

| Persona Key | Builder Method | Expected System Behaviour |
| :--- | :--- | :--- |
| `standard` | `UserBuilder.standardUser()` | Full access to inventory, cart, and checkout workflows without artificial latency. |
| `locked_out` | `UserBuilder.lockedOutUser()` | Blocked at login; must render an inline error banner: `Epic sadface: Sorry, this user has been locked out.` |
| `problem` | `UserBuilder.problemUser()` | Authenticated, but exhibits broken product thumbnails and state mutations on cart interactions. |
| `performance_glitch` | `UserBuilder.performanceGlitchUser()` | Authenticated, but login and inventory transitions incur artificial 5s delay. |

---

## 3. Core Business Rules & Invariants

1. **Authentication Gate:** Unauthenticated navigation to `/inventory.html` or `/cart.html` must redirect to `/` and display an access-denied banner.
2. **Inventory Catalog:** The default catalog contains **6 items**. Sorting supports Name (`az`, `za`) and Price (`lohi`, `hilo`).
3. **Cart Badge Synchronisation:** Adding an item transitions its button label from `Add to cart` to `Remove` and increments the primary header shopping cart badge count immediately.
4. **SOLID Test Data Rule:** Never hardcode usernames, passwords, or error banners inside `.spec.ts` files; always reference `UserBuilder` or `ProductBuilder` in `src/data/`.

---

## 4. Discovered Behaviours

<!-- Agents append newly discovered validation rules, dynamic UI timings, or API quirks below this line (FR-2.1) -->

- **[2026-10-25 | 01-cli-explorer]:** Login inputs expose both `placeholder` (`Username`, `Password`) and `data-test` attributes (`username`, `password`), while the submit control is an `<input type="submit" value="Login">` which maps to `getByRole('button', { name: 'Login' })` in the `.playwright-cli/page-*.yml` accessibility tree.
- **[2026-10-25 | 01-cli-explorer]:** Inventory cards repeat identical `Add to cart` buttons across all 6 products. To avoid Playwright strict-mode violations, item buttons must be scoped via a parent container (`locator('.inventory_item').filter({ hasText: productName })`) inside `InventoryListComponent`.
- **[2026-10-25 | 01-cli-explorer]:** Error banners inside the login container render inside `[data-test="error"]` with a dismiss button containing a child icon (`button.error-button`).
