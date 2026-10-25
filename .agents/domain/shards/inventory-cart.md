# Domain Shard: Inventory & Shopping Cart (`/inventory.html`, `/cart.html`)

> **Parent Index:** `.agents/domain/domain-memory.md` | **Max Lines:** 150

---

## 1. Business Invariants

1. **Catalog Size:** The default inventory catalog renders exactly **6 products**.
2. **Sort Options:** `[data-test="product-sort-container"]` supports `az` (Name A–Z), `za` (Name Z–A), `lohi` (Price low–high), and `hilo` (Price high–low).
3. **Cart State Mutation:** Clicking `Add to cart` on a product card transitions that card's button text to `Remove` and increments `[data-test="shopping-cart-badge"]`. Removing the last item hides the badge element completely.

---

## 2. Discovered Behaviours & Locator Quirks

- **[2026-10-25 | 01-cli-explorer]:** All 6 product cards render identical `Add to cart` / `Remove` button labels. To prevent Playwright strict-mode failures, always scope card buttons via `getByTestId('inventory-item').filter({ hasText: productName })`.
- **[2026-10-25 | 01-cli-explorer]:** Under `UserBuilder.problemUser()`, all 6 catalog cards render broken image `/static/media/sl-404.168b1cce.jpg` (logged in `defects/DEFECT-2026-10-25T12-00-00Z-problem-user-broken-images.md`).
