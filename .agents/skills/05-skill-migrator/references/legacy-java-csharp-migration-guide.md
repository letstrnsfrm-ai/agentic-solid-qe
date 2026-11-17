# Legacy Java & C# (.NET) Selenium + API Incremental Migration Guide

> **Scope:** Incremental, value-first porting of Java (JUnit/TestNG + Selenium/RestAssured/HttpClient) and C# (NUnit/xUnit/MSTest + Selenium/RestSharp/HttpClient) test suites into `agentic-solid-qe`.

---

## 1. Side-by-Side Installation in a Legacy Repo

When you run `init .` inside a Java (`pom.xml`, `build.gradle`) or C# (`*.sln`, `*.csproj`) repository:

```bash
npx --yes github:letstrnsfrm-ai/agentic-solid-qe init . --url https://your-app.com --name "Your App"
```

- **Zero Collision:** `init` auto-detects the Java/C# root and installs the Playwright suite side-by-side in `e2e-playwright/` (pass `--here` to override).
- **Manifest Seeding:** Seeds `.agents/domain/migration-manifest.json` with `legacySourceRoot: ".."` and an initial inventory of legacy tests.

---

## 2. Value-Based Discovery & Migration Waves

Run discovery from inside `e2e-playwright/`:

```bash
npm run migrate:skill -- --discover
```

Tests are scored (`valueScore`: 0–100) and grouped into **3 Migration Waves**:

| Wave | Criteria | Target Pattern |
| :--- | :--- | :--- |
| **Wave 1 (Quick Wins)** | Small `@smoke`/`@p0` UI tests & standalone API tests (RestAssured, RestSharp, HttpClient) | Direct 1-to-1 Session Tape ➔ `@p0`/`@api-contract` spec |
| **Wave 2 (Medium)** | Single-flow UI tests (`<= 80` lines, `<= 2` Page Objects) | Draft Tape ➔ `@playwright/cli` live verification ➔ `compile:tape` |
| **Wave 3 (Decompose)** | Monolithic E2E tests (`> 80` lines, `>= 5` assertions, or `>= 3` Page Objects/navigations) | Hybrid split into `api-seeder`, `auth-session`, and atomic UI slices |

---

## 3. Porting 1 Test (or Slice) at a Time

1. **Preview the Migration Plan & Slices:**
   ```bash
   npm run migrate:skill -- --legacy <test-id-or-file> [--slice <n>]
   ```
2. **Emit Draft Session Tape & Update Manifest:**
   ```bash
   npm run migrate:skill -- --legacy <test-id-or-file> [--slice <n>] --apply
   ```
   *(Pass `--static-only` if no live `BASE_URL` is reachable yet.)*
3. **Verify Live Locators via `@playwright/cli`:**
   Open `BASE_URL` with `npx playwright-cli -s=migrate-<id> open <url> --headed` and `snapshot` to refine any draft `locatorContract` entries into strict semantic locators (`getByRole`, `getByLabel`, `getByTestId`).
4. **Compile to SOLID TypeScript & Verify:**
   ```bash
   npm run compile:tape -- .exploratory/tapes/<scenario-id>.json --apply
   npm run verify
   ```

---

## 4. Parity Tracking (`.agents/domain/migration-manifest.json`)

Every legacy test progresses through `discovered ➔ decomposed ➔ taped ➔ verified` without mutating legacy Java/C# files. Run `npm run coverage:gaps` (`npx cortex orchestrate`) anytime to view `legacyMigrationProgress` and the next recommended Wave 1–3 test.
