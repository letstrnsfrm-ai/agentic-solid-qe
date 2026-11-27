#!/usr/bin/env node
/**
 * Sharded team workflow/policy overrides store (`.agents/overrides/<topic>.md`).
 *
 * Keeps core framework `SKILL.md` files frozen as lean routers while allowing
 * teams to accumulate durable workflow, tagging, healing, and CI policies over
 * 300+ days without lossy summarization or token-budget eviction.
 *
 * Each `.agents/overrides/<topic>.md` file declares lightweight scope metadata:
 *   **Scope:** global | skill:<id> | squad:<name> | route:<path> (comma-separated)
 *   **Last Verified:** YYYY-MM-DD (optional, recommended)
 */

import fs from 'node:fs';
import path from 'node:path';

const MAX_OVERRIDE_BYTES = 1024 * 1024;
export const VALID_SCOPE_PREFIXES = Object.freeze(['global', 'skill:', 'squad:', 'route:']);

function walkOverrideFiles(dir, rootDir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkOverrideFiles(full, rootDir));
    } else if (entry.name.endsWith('.md')) {
      try {
        const st = fs.lstatSync(full);
        if (st.isFile() && st.size <= MAX_OVERRIDE_BYTES) {
          out.push(full);
        }
      } catch {
        /* skip unreadable file */
      }
    }
  }
  return out.sort();
}

/**
 * Parses lightweight scope, last-verified date, title, and concise rule bullets
 * from an override markdown file. Supports either YAML frontmatter (`scope: ...`)
 * or bold markdown metadata (`**Scope:** ...`).
 */
export function parseOverrideFile(content, relPath = '') {
  const text = String(content || '');
  const lines = text.split(/\r?\n/);

  let rawScopes = '';
  let lastVerified = null;

  // Check optional YAML frontmatter first
  if (lines[0]?.trim() === '---') {
    const endIdx = lines.slice(1).findIndex((l) => l.trim() === '---');
    if (endIdx !== -1) {
      const fm = lines.slice(1, endIdx + 1).join('\n');
      const scopeFm = fm.match(/^scope\s*:\s*(.+)$/im);
      if (scopeFm) rawScopes = scopeFm[1].replace(/^\[|\]$/g, '').trim();
      const verifiedFm = fm.match(/^last[_-]?verified\s*:\s*(\d{4}-\d{2}-\d{2})/im);
      if (verifiedFm) lastVerified = verifiedFm[1];
    }
  }

  // Fallback to bold markdown metadata (**Scope:** ..., **Last Verified:** ...)
  if (!rawScopes) {
    const scopeMd = text.match(/\*\*Scope:\*\*\s*([^\n]+)/i);
    if (scopeMd) rawScopes = scopeMd[1].trim();
  }
  if (!lastVerified) {
    const verifiedMd = text.match(/\*\*Last Verified:\*\*\s*(\d{4}-\d{2}-\d{2})/i);
    if (verifiedMd) lastVerified = verifiedMd[1];
  }

  const scopes = rawScopes
    .split(/[,|]+/)
    .map((s) => s.replace(/`/g, '').trim().toLowerCase())
    .filter(Boolean);

  const heading = lines.find((l) => /^#\s+/.test(l))?.replace(/^#\s+/, '').trim() || path.basename(relPath, '.md');
  const bullets = lines
    .filter((l) => /^\s*[-*]\s+/.test(l))
    .map((l) => l.replace(/^\s*[-*]\s+/, '').trim())
    .filter((b) => !/^\*\*(Scope|Owner|Last Verified):/i.test(b))
    .slice(0, 8);

  return {
    rel: relPath,
    title: heading,
    scopes,
    lastVerified,
    bullets,
  };
}

export function isValidScopeToken(scopeToken) {
  const s = String(scopeToken || '').trim().toLowerCase();
  if (!s) return false;
  if (s === 'global') return true;
  return (
    (s.startsWith('skill:') && s.length > 'skill:'.length) ||
    (s.startsWith('squad:') && s.length > 'squad:'.length) ||
    (s.startsWith('route:') && s.length > 'route:'.length)
  );
}

/**
 * Collects and ranks matching `.agents/overrides/**\/*.md` entries for the active
 * Context Pack scope (`route`, `squad`, `skill`, `keywords`).
 */
export function collectOverrides(
  rootDir = process.cwd(),
  { route = '', squad = '', skill = '', keywords = [] } = {}
) {
  const overridesDir = path.join(rootDir, '.agents/overrides');
  if (!fs.existsSync(overridesDir)) return [];

  const files = walkOverrideFiles(overridesDir, rootDir);
  const normRoute = String(route || '').trim().toLowerCase();
  const normSquad = String(squad || '').trim().toLowerCase();
  const normSkill = String(skill || '').trim().toLowerCase();
  const lowerKeywords = [...new Set(keywords.map((k) => String(k || '').toLowerCase()).filter((k) => k.length >= 2))];

  const matched = [];
  for (const file of files) {
    if (path.basename(file).toLowerCase() === 'readme.md') continue;
    const rel = path.relative(rootDir, file).replace(/\\/g, '/');
    const content = fs.readFileSync(file, 'utf8');
    const parsed = parseOverrideFile(content, rel);

    let score = 0;
    let scopeMatched = false;

    for (const sc of parsed.scopes) {
      if (sc === 'global') {
        score += 10;
        scopeMatched = true;
      } else if (normRoute && sc.startsWith('route:')) {
        const target = sc.slice('route:'.length);
        if (normRoute.includes(target) || target.includes(normRoute)) {
          score += 40;
          scopeMatched = true;
        }
      } else if (normSquad && sc === `squad:${normSquad}`) {
        score += 35;
        scopeMatched = true;
      } else if (normSkill && sc === `skill:${normSkill}`) {
        score += 35;
        scopeMatched = true;
      }
    }

    // Keyword relevance tie-breaker (and fallback when no explicit scope filter is passed)
    const hay = `${parsed.rel} ${parsed.title} ${parsed.scopes.join(' ')} ${parsed.bullets.join(' ')}`.toLowerCase();
    let kwScore = 0;
    for (const kw of lowerKeywords) {
      if (hay.includes(kw)) kwScore += kw.length;
    }

    const hasExplicitFilter = Boolean(normRoute || normSquad || normSkill);
    if (scopeMatched || (!hasExplicitFilter && (kwScore > 0 || parsed.scopes.length === 0))) {
      matched.push({
        ...parsed,
        _score: score + kwScore,
      });
    }
  }

  return matched
    .sort((a, b) => b._score - a._score || a.rel.localeCompare(b.rel))
    .map(({ _score, ...rest }) => rest);
}

/**
 * Formats matched overrides into compact lines suitable for `context-pack.mjs`.
 */
export function formatOverridesForContextPack(overrides = [], { maxItems = 4, maxBullets = 2 } = {}) {
  if (!Array.isArray(overrides) || overrides.length === 0) return [];
  const lines = [`OVERRIDES (${overrides.length}):`];
  for (const ov of overrides.slice(0, maxItems)) {
    const scopeLabel = ov.scopes.length > 0 ? ov.scopes.join(', ') : 'unscoped';
    lines.push(`  - ${ov.rel} [${scopeLabel}]: ${ov.title}`);
    for (const b of ov.bullets.slice(0, maxBullets)) {
      const compact = b.length > 110 ? `${b.slice(0, 107)}...` : b;
      lines.push(`    * ${compact}`);
    }
  }
  return lines;
}
