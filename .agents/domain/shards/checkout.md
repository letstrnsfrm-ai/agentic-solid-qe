# Domain Shard: Checkout & Order Completion (`/checkout-step-one.html`, `/checkout-step-two.html`, `/checkout-complete.html`)

> **Parent Index:** `.agents/domain/domain-memory.md` | **Max Lines:** 150

---

## 1. Business Invariants

1. **Step One Customer Information (`/checkout-step-one.html`):**
   - Header title renders `Checkout: Your Information`.
   - Requires `First Name`, `Last Name`, and `Zip/Postal Code` before clicking `Continue` transitions to `/checkout-step-two.html`.
2. **Step Two Order Overview (`/checkout-step-two.html`):**
   - Header title renders `Checkout: Overview`.
   - Displays line items, payment info (`SauceCard #31337`), shipping info (`Free Pony Express Delivery!`), subtotal (`Item total: $29.99`), 8% tax (`Tax: $2.40`), and grand total (`Total: $32.39`).
3. **Order Completion (`/checkout-complete.html`):**
   - Clicking `Finish` clears the cart badge, renders header `Checkout: Complete!`, and displays level-2 heading `Thank you for your order!`.

---

## 2. Discovered Behaviours & Locator Quirks

- **[2026-10-25 | 01-cli-explorer]:** On `/cart.html`, the primary progression button is `getByRole('button', { name: 'Checkout', exact: true })` (`[data-test="checkout"]`).
- **[2026-10-25 | 01-cli-explorer]:** On `/checkout-step-one.html`, the shipping form exposes semantic placeholders `First Name`, `Last Name`, and `Zip/Postal Code` inside `form "Checkout information"` (`#checkout_info_container`), with submit control `getByRole('button', { name: 'Continue', exact: true })`.
- **[2026-10-25 | 01-cli-explorer]:** On `/checkout-step-two.html`, summary totals expose `[data-test="subtotal-label"]`, `[data-test="tax-label"]`, and `[data-test="total-label"]`, and the final submission button is `getByRole('button', { name: 'Finish', exact: true })` (`[data-test="finish"]`).
- **[2026-10-25 | 01-cli-explorer]:** On `/checkout-complete.html`, confirmation copy is inside `getByRole('heading', { name: 'Thank you for your order!', exact: true })` (`[data-test="complete-header"]`) alongside `Back Home` and `Generate PDF order` buttons.
