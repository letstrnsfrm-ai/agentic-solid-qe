# Agentic-SOLID-QE (`agentic-solid-qe`)

> **Zero-API-key, open-source agent skill framework bridging Autonomous Exploratory Testing (`@playwright/cli`) and Enterprise SOLID Playwright TypeScript Architecture (`@playwright/test`).**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Playwright CLI](https://img.shields.io/badge/Engine-%40playwright%2Fcli-2EAD33)](https://www.npmjs.com/package/@playwright/cli)
[![Playwright Test](https://img.shields.io/badge/Runner-%40playwright%2Ftest-45ba4b)](https://playwright.dev)

---

## Why `agentic-solid-qe`?

Current AI browser testing tools suffer from two major flaws:
1. **MCP-based browser agents** stream heavy accessibility trees and base64 screenshots into the LLM context window on every click, burning token budgets rapidly.
2. **Native codegen / flat test generators** output brittle, monolithic `.spec.ts` files with hardcoded strings and duplicate locators that fail enterprise PR reviews and break at scale in CI/CD.

**`agentic-solid-qe`** solves both problems using your existing IDE agent (Google Antigravity, GitHub Copilot, Claude Code, or Cursor) with **zero external OpenAI/Anthropic API keys**:
- **4–5x Lower Token Cost via `@playwright/cli`:** `01-cli-explorer` drives named browser sessions via `playwright-cli` and inspects compact `.playwright-cli/page-*.yml` disk snapshots instead of flooding LLM context.
- **Persistent Domain Memory & Hierarchical Session Tapes:** Discoveries are appended to `.agents/domain/domain-memory.md`, and verified user journeys are exported as strict JSON **Session Tapes** (`.exploratory/tapes/*.json`).
- **Deterministic SOLID Compilation & Audit Gate:** `02-solid-architect` compiles Session Tapes into atomic UI Components (`src/components/`), composed Pages (`src/pages/`), Liskov Contracts (`src/contracts/`), `test.extend` Fixtures (`src/fixtures/`), and Typed Data Builders (`src/data/`), verified by `npm run audit:solid`.

---

## System Architecture (4 Decoupled Layers)

```
agentic-solid-qe/
├── .agents/
│   ├── domain/
│   │   ├── domain-memory.md           # Layer 3: Living app rules, personas & discovered quirks
│   │   └── session-tape.schema.json   # Strict JSON contract between Skill 01 & Skill 02
│   └── skills/
│       ├── 01-cli-explorer/           # Layer 1: @playwright/cli Explorer & Defect Triage
│       │   ├── SKILL.md               # < 500 token routing index (Progressive Disclosure)
│       │   └── references/            # Exploratory charters & Markdown defect templates
│       └── 02-solid-architect/        # Layer 2: SOLID Playwright TypeScript Architect
│           ├── SKILL.md               # < 500 token routing index (Progressive Disclosure)
│           └── references/            # Canonical SOLID TypeScript patterns
├── .github/
│   ├── copilot-instructions.md        # Auto-bridges skills for GitHub Copilot
│   └── workflows/playwright-ci.yml    # Sharded GitHub Actions pipeline with SOLID gate
├── .azure-pipelines/playwright-ci.yml # Sharded Azure DevOps pipeline template
├── defects/                           # Structured Markdown bug reports + evidence pointers
├── .exploratory/tapes/                # Validated JSON Session Tapes
├── src/                               # Layer 4: Reference SOLID Playwright Framework
│   ├── contracts/                     # Shared TypeScript interfaces (LSP)
│   ├── components/                    # Atomic UI components <= 150 lines, zero expect() (SRP)
│   ├── pages/                         # Composed page workflows, zero expect() (SRP)
│   ├── fixtures/                      # Modular test.extend<>() dependency injection (OCP/ISP)
│   └── data/                          # Typed Data Builders — no magic strings in specs (DIP)
├── tests/                             # Clean, declarative web-first .spec.ts files
├── scripts/
│   ├── audit-solid.mjs                # Deterministic AST/regex gate enforcing SOLID & token caps
│   ├── validate-tapes.mjs             # Session Tape JSON schema validator
│   └── sync-skills.mjs                # Upgrades Core Engine without overwriting domain-memory.md
├── AGENTS.md                          # Universal entrypoint for Antigravity / Claude / Cursor
└── playwright.config.ts               # Production config (parallelism, retries, traces)
```

---

## Quick Start

### 1. Install Dependencies & Browsers
```bash
npm install
npx playwright install chromium
```

### 2. Run the Full Verification Gate (`typecheck` + `audit:solid` + `validate:tapes` + `playwright test`)
```bash
npm run verify
```

Or run individual checks:
```bash
npm run audit:solid      # Enforces <500 token skills, <=150 line components, zero expect() in src/, no magic strings
npm run validate:tapes   # Validates .exploratory/tapes/*.json against session-tape.schema.json
npx playwright test      # Runs the SOLID Playwright test suite
```

---

## End-to-End Walkthrough: Explore ➔ Triage ➔ SOLID Spec

### Step 1: Autonomous Exploration (`01-cli-explorer`)
Prompt your IDE agent (Antigravity, Copilot, Claude Code, or Cursor):
> *"Use `01-cli-explorer` to run the `multi-persona-auth` charter against SauceDemo using `.agents/domain/domain-memory.md`."*

The agent:
1. Reads `.agents/domain/domain-memory.md` for personas and invariants.
2. Runs `npx playwright-cli -s=explore open https://www.saucedemo.com`.
3. Inspects `.playwright-cli/page-*.yml` snapshots on disk, translating ephemeral refs (`e14`) into hierarchical parent-scoped locators (`#login_button_container` -> `getByPlaceholder('Username')`).
4. Logs any anomalies to `defects/DEFECT-<timestamp>.md` (see example in [`defects/DEFECT-2026-10-25T12-00-00Z-problem-user-broken-images.md`](./defects/DEFECT-2026-10-25T12-00-00Z-problem-user-broken-images.md)).
5. Emits a verified Session Tape to [`.exploratory/tapes/saucedemo-login-inventory.json`](./.exploratory/tapes/saucedemo-login-inventory.json).

### Step 2: SOLID Test Compilation (`02-solid-architect`)
Prompt your IDE agent:
> *"Use `02-solid-architect` to compile `.exploratory/tapes/saucedemo-login-inventory.json` into our SOLID test suite."*

The agent:
1. Audits `src/components/`, `src/pages/`, `src/data/`, and `src/fixtures/` to prevent duplicate code.
2. Generates/updates atomic components (`LoginFormComponent`, `InventoryListComponent`, `HeaderNavComponent`) exposing action methods and `readonly` semantic `Locator` properties.
3. Wires dependencies into `src/fixtures/app.fixture.ts` and test data into `src/data/user.builder.ts`.
4. Runs `npm run verify` until TypeScript, SOLID architecture rules, and headless Playwright tests pass.

---

## Installing or Upgrading in Existing Repositories

### Option A: One-Command Drop-In for Existing Projects (`npx`)
Inside **any existing TypeScript/Playwright repository**, run:

```bash
# Scaffold skills, domain-memory.md, and starter SOLID directories (never overwrites existing files):
npx github:letstrnsfrm-ai/agentic-solid-qe init

# Upgrade only the Core Engine (.agents/skills, schema, audit scripts) while preserving domain-memory.md & src/:
npx github:letstrnsfrm-ai/agentic-solid-qe sync
```

### Option B: Start a Brand-New Repository from the GitHub Template
Click **"Use this template"** on GitHub or run via GitHub CLI:
```bash
gh repo create my-app-e2e --template letstrnsfrm-ai/agentic-solid-qe --public --clone
cd my-app-e2e
npm install
npx playwright install chromium
npm run verify
```

---

## License

MIT © Agentic-SOLID-QE Contributors
