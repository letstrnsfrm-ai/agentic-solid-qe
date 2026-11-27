#!/usr/bin/env node
/**
 * Framework-maintainer line-count ratchet for `scripts/`.
 *
 * Runs automatically inside `audit:solid` ONLY in the framework repository itself
 * (detected by package.json `name === 'agentic-solid-qe'` and presence of
 * `scripts/script-size-baseline.json`) so consumer repos are never falsely failed.
 *
 * Rules:
 * - Any new script under `scripts/` (including `scripts/lib/` and `scripts/tests/`)
 *   must be <= `maxNewScriptLines` (default 500 lines).
 * - Legacy monoliths recorded in `scripts/script-size-baseline.json` (including
 *   `scripts/self-test.mjs`) cannot grow past their baseline line count — new logic
 *   must be extracted into modular files under `scripts/lib/` or `scripts/tests/`.
 */

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_MAX_NEW_SCRIPT_LINES = 500;
const BASELINE_REL_PATH = 'scripts/script-size-baseline.json';

function walkMjsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkMjsFiles(full));
    } else if (entry.name.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out.sort();
}

export function countFileLines(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content) return 0;
  return content.split(/\r?\n/).length;
}

export function isFrameworkRepo(rootDir = process.cwd()) {
  const pkgPath = path.join(rootDir, 'package.json');
  const baselinePath = path.join(rootDir, BASELINE_REL_PATH);
  if (!fs.existsSync(pkgPath) || !fs.existsSync(baselinePath)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg?.name === 'agentic-solid-qe';
  } catch {
    return false;
  }
}

/**
 * Audits `scripts/**\/*.mjs` against `scripts/script-size-baseline.json`.
 * Returns `{ active, violations, warnings, auditedCount }`.
 */
export function auditScriptsRatchet(rootDir = process.cwd()) {
  if (!isFrameworkRepo(rootDir)) {
    return { active: false, violations: [], warnings: [], auditedCount: 0 };
  }

  const baselinePath = path.join(rootDir, BASELINE_REL_PATH);
  let baseline;
  try {
    baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  } catch (err) {
    return {
      active: true,
      violations: [`[Script Size Ratchet] Failed to parse ${BASELINE_REL_PATH}: ${err.message}`],
      warnings: [],
      auditedCount: 0,
    };
  }

  const maxNewLines =
    typeof baseline?.maxNewScriptLines === 'number' && baseline.maxNewScriptLines > 0
      ? baseline.maxNewScriptLines
      : DEFAULT_MAX_NEW_SCRIPT_LINES;
  const legacyCaps = baseline?.legacyBaselines && typeof baseline.legacyBaselines === 'object'
    ? baseline.legacyBaselines
    : {};

  const violations = [];
  const warnings = [];
  const scriptsDir = path.join(rootDir, 'scripts');
  const files = walkMjsFiles(scriptsDir);

  for (const file of files) {
    const rel = path.relative(rootDir, file).replace(/\\/g, '/');
    const lines = countFileLines(file);

    if (Object.hasOwn(legacyCaps, rel)) {
      const cap = legacyCaps[rel];
      if (lines > cap) {
        const hint = rel === 'scripts/self-test.mjs'
          ? 'Add new tests in modular scripts/tests/*.test.mjs files (<= 500 lines) instead of growing scripts/self-test.mjs.'
          : 'Extract new logic into modular helpers under scripts/lib/ (<= 500 lines) instead of growing this monolith.';
        violations.push(
          `[Script Size Ratchet] ${rel} grew to ${lines} lines (ratchet baseline ${cap}). ${hint}`
        );
      } else if (lines <= maxNewLines) {
        warnings.push(
          `[Script Ratchet Cleanup] ${rel} is now ${lines} lines (<= ${maxNewLines}). Remove it from ${BASELINE_REL_PATH} to lock in the modular size.`
        );
      } else if (cap - lines >= 50) {
        warnings.push(
          `[Script Ratchet Tighten] ${rel} shrank to ${lines} lines (baseline ${cap}). Tighten its cap in ${BASELINE_REL_PATH}.`
        );
      }
    } else if (lines > maxNewLines) {
      violations.push(
        `[Script Size Budget] ${rel} has ${lines} lines (max ${maxNewLines} for new/modular scripts). Split into focused modules under scripts/lib/ or scripts/tests/.`
      );
    }
  }

  return { active: true, violations, warnings, auditedCount: files.length };
}
