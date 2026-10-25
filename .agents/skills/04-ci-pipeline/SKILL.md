---
name: 04-ci-pipeline
description: Curates regression execution tags (@p0, @smoke, @regression), hardens playwright.config.ts for deployed environments, and configures sharded CI/CD pipelines (GitHub Actions / Azure DevOps / GitLab). Invoke /04-ci-pipeline before running in CI/CD.
---

# Skill 04: CI/CD Pipeline & Regression Suite Curator

## 1. Zero-Prompt Auto-Start: Suite & Tag Readiness Audit
When invoked as `/04-ci-pipeline`, immediately execute:
1. Run `npm run coverage:gaps` and inspect `tests/*.spec.ts` and `.exploratory/tapes/*.json`.
2. Verify every automated spec includes priority and suite tags (`@p0`, `@smoke`, `@regression`) matching its Session Tape risk tier.

## 2. Deployed Environment & Config Hardening (`references/ci-templates.md`)
1. Audit `playwright.config.ts` to ensure:
   - `baseURL` reads `process.env.BASE_URL` with fallback to `.agents/domain/domain-memory.md`.
   - `trace: 'on-first-retry'`, `screenshot: 'only-on-failure'`, and CI retries (`retries: process.env.CI ? 2 : 0`) are enabled for multi-page diagnostics.
2. Verify `src/data/*.builder.ts` consumes environment secrets (`TEST_USERNAME`, `TEST_PASSWORD`) with safe defaults.

## 3. Sharded CI/CD Pipeline Generation & Verification
1. Inspect or scaffold `.github/workflows/playwright-ci.yml` or `.azure-pipelines/playwright-ci.yml` (`references/ci-templates.md`) with:
   - Pre-flight quality gates (`npm run typecheck`, `npm run audit:solid`, `npm run validate:tapes`).
   - Sharded matrix execution (`--shard`) and tag-filtered smoke/regression jobs (`--grep @smoke`).
2. Run `npm run verify` to confirm 100% pipeline readiness.
