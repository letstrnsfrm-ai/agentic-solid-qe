#!/usr/bin/env node
/**
 * Operational QE Ontology — Public Barrel & `npx cortex ontology` CLI.
 * Modular implementation lives under `scripts/lib/ontology/` (each <= 500 lines).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ONTOLOGY_REL_PATH, loadOntology } from './ontology/core.mjs';
import { validateOntology } from './ontology/validate.mjs';
import { compileOntologyIndex } from './ontology/compile.mjs';
import { seedOntologyFile } from './ontology/infer.mjs';

export * from './ontology/core.mjs';
export * from './ontology/validate.mjs';
export * from './ontology/compile.mjs';
export * from './ontology/infer.mjs';
export * from './ontology/integrations.mjs';

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
🧬 Cortex Operational QE Ontology CLI (npx cortex ontology)

Usage:
  npx cortex ontology [--gaps] [--json]               Show ontology summary & uncovered semantic gaps (default)
  npx cortex ontology --validate [--json]             Validate .agents/domain/ontology.json & src/ symbol integrity
  npx cortex ontology --seed [--dry-run] [--force]    Infer & seed starter .agents/domain/ontology.json from shards/tapes/src
`);
    process.exit(0);
  }

  const rootDir = process.cwd();
  const asJson = args.includes('--json');

  if (args.includes('--seed')) {
    const dryRun = args.includes('--dry-run');
    const force = args.includes('--force');
    const res = seedOntologyFile(rootDir, { dryRun, force });
    if (asJson) {
      console.log(JSON.stringify(res, null, 2));
    } else if (res.alreadyExists && !force && !dryRun) {
      console.log(`ℹ️  ${ONTOLOGY_REL_PATH} already exists. Pass --force to overwrite or --dry-run to preview.`);
    } else if (!res.valid) {
      console.error(`❌ Inferred ontology failed validation (file not written):`);
      for (const e of res.errors || []) console.error(`  - ${e}`);
    } else {
      const s = res.ontology;
      console.log(
        `${dryRun ? '🔎 [dry-run] Inferred' : '🌱 Seeded'} ${ONTOLOGY_REL_PATH}: ${s.entities.length} entities, ${s.links.length} links, ${s.actions.length} actions, ${s.invariants.length} invariants (valid=${res.valid}).`
      );
    }
    process.exit(res.valid === false ? 1 : 0);
  }

  if (args.includes('--validate')) {
    const loaded = loadOntology(rootDir);
    if (!loaded.exists) {
      console.log(`ℹ️  No ${ONTOLOGY_REL_PATH} found (Progressive Strictness: opt-in). Run 'npx cortex ontology --seed' to create one.`);
      process.exit(0);
    }
    if (loaded.parseError) {
      console.error(`❌ ${loaded.parseError}`);
      process.exit(1);
    }
    const res = validateOntology(loaded.ontology, { rootDir, checkSrcSymbols: true });
    if (asJson) {
      console.log(JSON.stringify(res, null, 2));
    } else if (res.valid) {
      console.log(`✅ Ontology valid: ${ONTOLOGY_REL_PATH} (${loaded.ontology.entities.length} entities, ${loaded.ontology.actions.length} actions, ${loaded.ontology.invariants.length} invariants).`);
    } else {
      console.error('❌ Ontology validation failed:');
      for (const e of res.errors) console.error(`  - ${e}`);
    }
    process.exit(res.valid ? 0 : 1);
  }

  const compiled = compileOntologyIndex(rootDir);
  if (!compiled) {
    if (asJson) {
      console.log(JSON.stringify({ exists: false, path: ONTOLOGY_REL_PATH, gaps: [] }, null, 2));
    } else {
      console.log(`ℹ️  No ${ONTOLOGY_REL_PATH} found. Run 'npx cortex ontology --seed' to infer a starter ontology.`);
    }
    process.exit(0);
  }
  if (asJson) {
    console.log(JSON.stringify({ domain: compiled.domain, summary: compiled.summary, coverage: compiled.coverage }, null, 2));
  } else {
    const os = compiled.summary;
    console.log(
      `ONTOL  | domain=${compiled.domain} | entities=${os.coveredEntities}/${os.entities} actions=${os.coveredActions}/${os.actions} transitions=${os.coveredTransitions}/${os.transitions} invariants=${os.coveredInvariants}/${os.invariants}`
    );
    for (const g of compiled.coverage.gaps.slice(0, 10)) {
      console.log(`GAP    | [${g.priority.toUpperCase()}] (${g.kind}) ${g.target} — ${g.summary}`);
    }
    if (compiled.coverage.gaps.length === 0) {
      console.log('GAPS   | None — all modeled entities, transitions, and invariants are covered.');
    }
  }
}
