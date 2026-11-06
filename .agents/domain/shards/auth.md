# Domain Shard: Authentication & Access Control (`/`)

> **Parent Index:** `.agents/domain/domain-memory.md` | **Max Lines:** 150
> **Owner Squad:** `@org/identity-squad` | **Last Verified:** `2026-11-06`
> **Published Capabilities:** `LoginPage`, `LoginFormComponent`, `ErrorBannerContract`, `UserBuilder`

---

## 1. Business Invariants & State Transitions

1. **Authentication Gate:** Direct unauthenticated navigation to `/inventory.html` or `/cart.html` redirects to `/` and renders: `Epic sadface: You can only access '/inventory.html' when you are logged in.`
2. **Locked-Out Persona:** Submitting `UserBuilder.lockedOutUser()` must remain on `/` and display: `Epic sadface: Sorry, this user has been locked out.`
3. **Dismissible Error Banner:** Clicking the dismiss control inside the error banner hides the banner without reloading the page.

---

## 2. API, Session & Storage Contracts (Cross-Squad Preconditions)

- **Auth Session Cookie:** Successful login sets cookie `session-username=<persona.username>` on domain `www.saucedemo.com`.
- **Downstream Seeding Rule:** Downstream squads (`@org/catalog-squad`, `@org/checkout-squad`) may bypass UI login in non-auth specs by restoring `.auth/<persona>.json` (`storageState`) or seeding cookie `session-username`.

---

## 3. Discovered Behaviours & Locator Quirks

- **[2026-10-25 | 01-cli-explorer]:** Login inputs expose both `placeholder` (`Username`, `Password`) and `data-test` (`username`, `password`) inside `#login_button_container`.
- **[2026-10-25 | 01-cli-explorer]:** The submit control `<input type="submit" value="Login">` maps to `getByRole('button', { name: 'Login', exact: true })` in `.playwright-cli/page-*.yml`.
- **[2026-10-25 | 01-cli-explorer]:** Validation banners render in `[data-test="error"]` with dismiss button `[data-test="error-button"]`.
