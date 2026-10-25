#!/usr/bin/env node
/**
 * Validates all JSON Session Tapes in .exploratory/tapes/ against .agents/domain/session-tape.schema.json.
 * Zero external dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TAPES_DIR = path.join(ROOT, '.exploratory/tapes');
const SCHEMA_PATH = path.join(ROOT, '.agents/domain/session-tape.schema.json');

if (!fs.existsSync(SCHEMA_PATH)) {
  console.error('❌ Missing schema file at .agents/domain/session-tape.schema.json');
  process.exit(1);
}

const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
const VALID_CHARTERS = new Set(schema.properties.charter.enum);
const VALID_ACTIONS = new Set(schema.properties.semanticSteps.items.properties.action.enum);
const VALID_STRATEGIES = new Set(
  schema.properties.semanticSteps.items.properties.locatorContract.properties.strategy.enum
);
const VALID_ASSERTIONS = new Set(
  schema.properties.expectedStates.items.properties.assertionType.enum
);

if (!fs.existsSync(TAPES_DIR)) {
  console.log('ℹ️ No .exploratory/tapes directory found. Skipping tape validation.');
  process.exit(0);
}

const tapeFiles = fs.readdirSync(TAPES_DIR).filter((f) => f.endsWith('.json'));
let errors = [];

for (const file of tapeFiles) {
  const fullPath = path.join(TAPES_DIR, file);
  let tape;
  try {
    tape = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  } catch (err) {
    errors.push(`[${file}] Invalid JSON: ${err.message}`);
    continue;
  }

  for (const reqField of schema.required) {
    if (tape[reqField] === undefined) {
      errors.push(`[${file}] Missing required root field '${reqField}'.`);
    }
  }

  if (tape.schemaVersion !== '1.0.0') {
    errors.push(`[${file}] Unsupported schemaVersion '${tape.schemaVersion}' (expected '1.0.0').`);
  }

  if (!VALID_CHARTERS.has(tape.charter)) {
    errors.push(`[${file}] Invalid charter '${tape.charter}'.`);
  }

  if (!Array.isArray(tape.semanticSteps) || tape.semanticSteps.length === 0) {
    errors.push(`[${file}] semanticSteps must be a non-empty array.`);
  } else {
    for (const step of tape.semanticSteps) {
      if (!VALID_ACTIONS.has(step.action)) {
        errors.push(`[${file} step #${step.stepIndex}] Invalid action '${step.action}'.`);
      }
      if (!step.locatorContract || !VALID_STRATEGIES.has(step.locatorContract.strategy)) {
        errors.push(
          `[${file} step #${step.stepIndex}] Invalid or missing locatorContract.strategy.`
        );
      }
      if (/^e\d+$/.test(step.locatorContract?.value ?? '')) {
        errors.push(
          `[${file} step #${step.stepIndex}] Ephemeral CLI ref '${step.locatorContract.value}' leaked into locatorContract.value!`
        );
      }
    }
  }

  if (!Array.isArray(tape.expectedStates) || tape.expectedStates.length === 0) {
    errors.push(`[${file}] expectedStates must be a non-empty array.`);
  } else {
    for (const state of tape.expectedStates) {
      if (!VALID_ASSERTIONS.has(state.assertionType)) {
        errors.push(`[${file}] Invalid assertionType '${state.assertionType}'.`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error('\n❌ Session Tape Validation Failed:\n');
  for (const e of errors) {
    console.error(`  - ${e}`);
  }
  process.exit(1);
}

console.log(`✅ Session Tape Validation Passed (${tapeFiles.length} tape(s) verified against session-tape.schema.json).`);
