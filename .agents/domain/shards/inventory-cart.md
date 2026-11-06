# Domain Shard: Inventory & Shopping Cart (`/inventory.html`, `/cart.html`)

> **Parent Index:** `.agents/domain/domain-memory.md` | **Max Lines:** 150
> **Owner Squad:** `@org/catalog-squad` | **Last Verified:** `2026-11-06`
> **Published Capabilities:** `InventoryPage`, `InventoryItemCard`, `HeaderCartBadgeComponent`, `ProductBuilder`

---

## 1. Business Invariants & State Transitions

1. **Catalog Size:** The default inventory catalog renders exactly **6 products**.
2. **Sort Options:** `[data-test="product-sort-container"]` supports `az` (Name A–Z), `za` (Name Z–A), `lohi` (Price low–high), and `hilo` (Price high–low).
3. **Cart State Mutation:** Clicking `Add to cart` on a product card transitions that card's button text to `Remove` and increments `[data-test="shopping-cart-badge"]`. Removing the last item hides the badge element completely.

---

## 2. API, Session & Storage Contracts (Cross-Squad Preconditions)

- **Client Cart Persistence:** Active cart item IDs are persisted as a JSON array in `window.localStorage.getItem('cart-contents')` (e.g., `[4, 0]`).
- **Downstream Seeding Rule:** Checkout specs can pre-populate cart items via `localStorage` key `cart-contents` or `InventoryPage.addProductToCart(productName)`.

---

## 3. Discovered Behaviours & Locator Quirks

- **[2026-10-25 | 01-cli-explorer]:** All 6 product cards render identical `Add to cart` / `Remove` button labels. To prevent Playwright strict-mode failures, always scope card buttons via `getByTestId('inventory-item').filter({ hasText: productName })`.
- **[2026-10-25 | 01-cli-explorer]:** Under `UserBuilder.problemUser()`, all 6 catalog cards render broken image `/static/media/sl-404.168b1cce.jpg` (logged in `defects/DEFECT-2026-10-25T12-00-00Z-problem-user-broken-images.md`).
