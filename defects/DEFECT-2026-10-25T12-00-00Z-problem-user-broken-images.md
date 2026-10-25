# DEFECT: Problem Persona Renders Broken Dog Thumbnail Across All 6 Catalog Items

- **Timestamp:** 2026-10-25T12:00:00Z
- **Charter:** `multi-persona-auth`
- **Persona:** `problem` (`UserBuilder.problemUser()`)
- **URL:** `https://www.saucedemo.com/inventory.html`
- **Severity:** Medium

## 1. Summary
When authenticating with the `problem` persona, every product card in the inventory catalog displays an identical broken placeholder thumbnail (`/static/media/sl-404.168b1cce.jpg`) instead of the item-specific product image.

## 2. Reproduction Steps (Semantic Locators)
1. Navigate to `https://www.saucedemo.com/`
2. Fill `#login_button_container -> getByPlaceholder('Username')` (`cliRef: e4`) with `UserBuilder.problemUser().username`
3. Fill `#login_button_container -> getByPlaceholder('Password')` (`cliRef: e5`) with `UserBuilder.problemUser().password`
4. Click `#login_button_container -> getByRole('button', { name: 'Login' })` (`cliRef: e6`)
5. Inspect `getByTestId('inventory-item') -> getByRole('img')` across all 6 product cards (`cliRef: e11..e26`)

## 3. Expected vs. Actual Behaviour
- **Expected:** Each catalog item renders its unique product image URL matching the item title.
- **Actual:** All 6 catalog items render `/static/media/sl-404.168b1cce.jpg`.

## 4. Evidence & Diagnostics
- **Console Errors:** `None`
- **Snapshot Pointer:** `.playwright-cli/page-2026-10-25T12-00-00.yml`
- **Screenshot:** `defects/screenshots/problem-user-broken-images.png`
