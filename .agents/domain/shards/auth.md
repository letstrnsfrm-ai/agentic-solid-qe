# Domain Shard: Authentication & Access Control (`/`)

> **Parent Index:** `.agents/domain/domain-memory.md` | **Max Lines:** 150

---

## 1. Business Invariants

1. **Authentication Gate:** Direct unauthenticated navigation to `/inventory.html` or `/cart.html` redirects to `/` and renders: `Epic sadface: You can only access '/inventory.html' when you are logged in.`
2. **Locked-Out Persona:** Submitting `UserBuilder.lockedOutUser()` must remain on `/` and display: `Epic sadface: Sorry, this user has been locked out.`
3. **Dismissible Error Banner:** Clicking the dismiss control inside the error banner hides the banner without reloading the page.

---

## 2. Discovered Behaviours & Locator Quirks

- **[2026-10-25 | 01-cli-explorer]:** Login inputs expose both `placeholder` (`Username`, `Password`) and `data-test` (`username`, `password`) inside `#login_button_container`.
- **[2026-10-25 | 01-cli-explorer]:** The submit control `<input type="submit" value="Login">` maps to `getByRole('button', { name: 'Login', exact: true })` in `.playwright-cli/page-*.yml`.
- **[2026-10-25 | 01-cli-explorer]:** Validation banners render in `[data-test="error"]` with dismiss button `[data-test="error-button"]`.
