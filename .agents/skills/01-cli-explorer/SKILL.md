---
name: 01-cli-explorer
description: Autonomous feature discovery, multi-page/multi-portal exploration, API discovery, and 1-test-at-a-time coverage curation via agent-browser and cortex explore.
---

# Skill 01: CLI Explorer & Coverage Curator

## 1. Recon & Resume-First Start (FR-1.1)
1. Run `npx cortex context [--route <p>|--squad <s>]` (`≤ 400` tok), `npm run coverage:gaps -- --compact`, and `npx cortex ontology --gaps`.
2. **Start (`npx cortex explore`, headless):** Prefer `--from-spec <spec> [--until-step "<step>"]`, `--from-seed <seeder> --url <url>`, or `--checkpoint <name>`; use `--url <baseUrl>` only for new routes.
3. **Checkpoint 1:** Present **Top 3 Uncovered Scenarios** (`references/charters.md`); pick **1**.

## 2. Batched Exploration & Variants (FR-1.2, FR-1.3)
- **Batch:** `npx cortex explore batch '[["fill","@e2","..."],["click","@e5"],["assert","@e9","toContainText","..."]]' --step "<business>" --scope main`
- **State/Portals:** `capture <var>`, `checkpoint save <name>`, `actor <id> --url <url> --auth .auth/<p>.json`.
- **Tapes:** `npx cortex tape clone|patch` (bind `ontology` entities/transitions/invariants).

## 3. Defects, Shards & Finish (FR-1.4, FR-1.5)
- **Defects:** `npx agent-browser --session explore screenshot defects/evidence.png --annotate` + `defects/DEFECT-<ts>.md`.
- **Finish:** Debrief Matrix, update shard (`≤ 150`L), run `npx cortex explore finish --scenario <id> --compile --verify` + `npm run domain:graph -- --seed-from-tapes`.

## 4. Lazy References (Read ONLY When Needed)
- `references/charters.md` — Charters & oracles.
- `references/charter-resume-and-codegen.md` — Resume, codegen & `resumesFrom`.
- `references/charter-complex-ui-and-a11y.md` — Wizards, APIs, portals, overlays, iframes.
- `references/charter-nfr.md` — NFR (`@a11y`, `@perf`, `@security`, `@visual`).
- `references/charter-debrief-and-tapes.md` — Debrief Matrix & `cortex tape`.
- `references/defect-template.md` — Defect template.
