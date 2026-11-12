# Friction Log: Conduit (RealWorld) trial of `npx init` on a non-SauceDemo app (2026-11-11)
1. `init` succeeds, `npm run verify` passes on empty scaffold (good).
2. init output doesn't mention `npx playwright install` — no browsers present after init + npm install.
3. `playwright-cli open` defaults to the `chrome` channel (needs /opt/google/chrome); fails on machines without Chrome. Docs/skills should say `--browser=chromium`-style fallback (note: --help lists only chrome/firefox/webkit/msedge, so `--browser=chromium` is undocumented).
4. In this sandbox the browser hits ERR_CERT_AUTHORITY_INVALID (proxy CA not trusted by Chromium). Environmental; unresolved.
5. User-approved: ignoreHTTPSErrors via .playwright/cli.config.json in trial folder only (sandbox proxy CA).
6. Snapshot written by `goto`/`open` is captured before Angular renders (only nav+footer); a later `snapshot` shows the real page. Skills should say: re-run `snapshot` after SPA navigation, don't trust the auto-snapshot file.
7. Later snapshots print inline, not to `.playwright-cli/page-*.yml` (skill guardrail says to read disk snapshots) — use `--filename` to force disk output.
8. Registration of throwaway user on demo.realworld.show works; creds stored in git-ignored .env.
9. **SECURITY/HIGH:** `init` creates NO .gitignore. `.env`, `.auth/*.json` (session tokens), `node_modules`, `test-results`, `playwright-report`, `.playwright-cli` are all unprotected in an adopter repo. (.env.example tells users .env is "git-ignored" — false.) Fix: init should create/merge a .gitignore.
10. Browser session silently died after ~3 min idle (headless idle-timeout/daemon) — "Browser 'conduit' is not open". Skills should instruct reopening with storageState via `.playwright/cli.config.json` (`browser.contextOptions.storageState`), which worked.
11. Action output header "Page URL" is stale after SPA navigation (showed /editor while page was /article/qe-trial-article). Use `eval "() => location.href"` for URL truth when building tape `waitForUrl` values.
12. Flow mapped: register -> home feed -> /editor (title, about, body, tags + Enter) -> Publish -> /article/<slug> (slug = kebab title) -> Post Comment. Data-test attrs absent; roles/placeholders only (so playwright.config `testIdAttribute: 'data-test'` default is wrong for this app).
13. Verified flows: delete article -> redirect `/`, article URL then renders empty shell (no 404 message — app observation, candidate low-sev defect). Invalid login -> inline `credentials invalid` + API 401 at https://api.realworld.show/api/users/login (expected; console logs it as [ERROR], so a naive "console errors == 0" oracle in 01-cli-explorer would false-positive).
14. API is on a separate origin (api.realworld.show) — skills/tapes assume same-origin `baseURL`; need an `apiBaseUrl` convention for API oracle checks and data seeding.
15. Auth/state persisted server-side across CLI sessions (article+comment survived reopen) — tapes must clean up created data (delete article) or use unique slugs.
16. Tape schema gaps hit while writing Conduit tapes: (a) no way to say "press Enter" key value for tag input (`press` action has no key field); (b) API on another origin — `waitForNetwork` works only as a free-form string, `baseUrl` is single-origin; (c) `capturesVariable` with source `urlParam` doesn't describe path segments (slug); (d) `UserBuilder.unknownUser`/ArticleBuilder refs are only symbolic — validate-tapes doesn't check that a referenced builder exists until audit/compile.
17. `persona.role` enum in the generated UserPersona type is `string`, but tapes allow `unauthenticated` with a builder method — init scaffold only provides `standardUser`, so every adopter must hand-add builders before verify.
18. Positive: `validate:tapes` and `coverage:gaps` correctly detected the 2 uncompiled tapes and recommended /02-solid-architect.
19. COMPILE PHASE: both tapes compiled to 4 components, 3 pages, 3 fixtures, 2 specs + auth.setup; `npm run verify` green (3 passed). Only 1 typecheck fix needed (unused ctor `private readonly page` — solid-patterns.md templates encourage this under `noUnusedLocals`).
20. Scaffold gaps I had to hand-write: (a) playwright.config.ts doesn't load `.env` (TEST_PASSWORD missing -> throws) — added `process.loadEnvFile`; (b) no `setup` project / auth.setup.ts to mint `.auth/standard.json` from env creds, though tapes reference `storageStatePath` — added setup project + `dependencies`; (c) default `testIdAttribute: 'data-test'` baked in; (d) no env-gated `ignoreHTTPSErrors` for proxied/corporate networks (added `IGNORE_HTTPS_ERRORS=1`).
21. The framework's `audit:solid` literal check passed with 9 builder literals; it did not flag that the `.banner` / `app-auth-page` CSS locators in components are weaker than role-based ones (no guidance on when CSS is acceptable).
22. Tape->code is manual here: no generator exists, so quality depends on the agent following solid-patterns.md. Tape `press` gap (16a) was worked around by coding `press('Enter')` in the component, so the tape no longer fully describes the spec.
23. CI: `init` ships NO `.github/workflows/playwright-ci.yml` to adopters (the framework repo has one; skill 04 says "inspect or scaffold"). I authored one: arch gate -> smoke (`--grep "@smoke|@p0"`) on PRs -> sharded regression on push, secrets wired (TEST_USERNAME/TEST_PASSWORD), SHA-pinned actions. Verified empirically that `--grep` does NOT filter the `setup` dependency project (setup still ran), so storageState minting survives tag filtering.
24. `domain-memory.md` remained the init placeholder (0 shards, 0 routes) after the whole trial — nothing in skills 01/02 forced seeding feature shards from explored routes, so `domain:graph` reports 0 indexed routes despite 2 passing specs. 00-env-bootstrap was only partially exercised (manual CLI).
25. `.github/copilot-instructions.md`, `.claude/commands/*`, `AGENTS.md` all synced OK on init (positive).

---
## Addressed in this PR
- #2 (next steps now mention `npx playwright install chromium`), #9 (init now creates/merges `.gitignore`), #20a/#20d (config template loads `.env`, env-gated `IGNORE_HTTPS_ERRORS`), #20c (comment on `testIdAttribute`).

## Open follow-ups (not in this PR)
#3/#6/#7/#10/#11 skill guidance (browser fallback, re-snapshot after SPA nav, `--filename`, reopen with storageState, `location.href`), #14/#16 tape schema (multi-origin API, `press` key, path-segment capture), #20b auth `setup` project scaffold, #23 ship adopter CI workflow with secrets wiring, #24 shard seeding from explored routes.
