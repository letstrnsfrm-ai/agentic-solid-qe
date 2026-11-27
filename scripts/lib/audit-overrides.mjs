#!/usr/bin/env node
/**
 * Deterministic audit for `.agents/overrides/` sharded team policies and legacy
 * `references/local-overrides.md` files.
 *
 * Ensures team workflow/policy rules scale over 300+ days without lossy
 * summarization or overflowing core `SKILL.md` files.
 */

import fs from 'node:fs';
import path from 'node:path';
import { estimateTokens, TOKEN_BUDGETS } from './cli-output.mjs';
import { isValidScopeToken, parseOverrideFile } from './overrides-store.mjs';

const MAX_SCAN_FILE_BYTES = 1024 * 1024;
const OVERRIDE_STALE_DAYS = 90;

function walkOverrides(dir, rootDir, violations) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(rootDir, full).replace(/\\/g, '/');
    if (entry.isSymbolicLink()) {
      violations.push(
        `[Enterprise Code Security Gate] ${rel} is a symbolic link inside .agents/overrides/. Remove symbolic links from audited directories.`
      );
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...walkOverrides(full, rootDir, violations));
    } else if (entry.name.endsWith('.md')) {
      const st = fs.lstatSync(full);
      if (!st.isFile()) continue;
      if (st.size > MAX_SCAN_FILE_BYTES) {
        violations.push(
          `[Enterprise Code Security Gate] ${rel} exceeds the 1 MB static-audit size cap (${st.size} bytes).`
        );
        continue;
      }
      files.push(full);
    }
  }
  return files.sort();
}

/**
 * Audits `.agents/overrides/**\/*.md` and legacy `references/local-overrides.md`.
 * Returns `{ violations, warnings, overrideCount }`.
 */
export function auditOverrides(rootDir = process.cwd(), { maxTokens = TOKEN_BUDGETS.overrideMd } = {}) {
  const violations = [];
  const warnings = [];
  const overridesDir = path.join(rootDir, '.agents/overrides');
  const files = walkOverrides(overridesDir, rootDir, violations);

  let overrideCount = 0;
  for (const file of files) {
    if (path.basename(file).toLowerCase() === 'readme.md') continue;
    overrideCount++;
    const rel = path.relative(rootDir, file).replace(/\\/g, '/');
    const content = fs.readFileSync(file, 'utf8');
    const tokens = estimateTokens(content);

    if (tokens > maxTokens) {
      violations.push(
        `[Override Token Budget] ${rel} is ~${tokens} tokens (max ${maxTokens}). Split into focused topic files under .agents/overrides/<topic>.md instead of summarizing or deleting older rules.`
      );
    }

    const parsed = parseOverrideFile(content, rel);
    if (parsed.scopes.length === 0) {
      violations.push(
        `[Override Scope Missing] ${rel} must declare '**Scope:** global' or targeted scopes (skill:<id>, squad:<name>, route:<path>) so context-pack.mjs can retrieve it lazily.`
      );
    } else {
      const invalid = parsed.scopes.filter((s) => !isValidScopeToken(s));
      if (invalid.length > 0) {
        violations.push(
          `[Override Scope Invalid] ${rel} has invalid scope token(s): ${invalid.join(', ')}. Use global, skill:<id>, squad:<name>, or route:<path>.`
        );
      }
    }

    if (parsed.lastVerified) {
      const verifiedMs = Date.parse(`${parsed.lastVerified}T00:00:00Z`);
      if (!Number.isNaN(verifiedMs)) {
        const ageDays = Math.floor((Date.now() - verifiedMs) / (1000 * 60 * 60 * 24));
        if (ageDays > OVERRIDE_STALE_DAYS) {
          warnings.push(
            `[Override Staleness Advisory] ${rel} was last verified ${ageDays} days ago (${parsed.lastVerified}). Review and update '**Last Verified:**' or retire obsolete rules.`
          );
        }
      }
    }
  }

  // Advisory check on legacy per-skill references/local-overrides.md files
  const skillsDir = path.join(rootDir, '.agents/skills');
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const legacyFile = path.join(skillsDir, entry.name, 'references', 'local-overrides.md');
      if (!fs.existsSync(legacyFile)) continue;
      try {
        const st = fs.lstatSync(legacyFile);
        if (st.isSymbolicLink() || !st.isFile()) continue;
        const tok = estimateTokens(fs.readFileSync(legacyFile, 'utf8'));
        const rel = path.relative(rootDir, legacyFile).replace(/\\/g, '/');
        if (tok > maxTokens) {
          warnings.push(
            `[Legacy Override Migration Advisory] ${rel} is ~${tok} tokens (target <= ${maxTokens}). Split team policies into .agents/overrides/<topic>.md with '**Scope:** skill:${entry.name}'.`
          );
        }
      } catch {
        /* skip unreadable */
      }
    }
  }

  return { violations, warnings, overrideCount };
}
