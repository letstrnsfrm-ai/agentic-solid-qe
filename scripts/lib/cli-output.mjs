#!/usr/bin/env node
/**
 * Shared token-efficiency & compact agent-output utilities for Agentic-SOLID-QE CLI scripts.
 *
 * Centralizes:
 * - Deterministic token estimation (identical to audit:solid budget formula)
 * - ANSI escape stripping
 * - Compact mode auto-detection (--compact, CORTEX_COMPACT=1, or non-TTY unless --verbose/--full)
 * - Bounded line capping & failure-only Playwright / Node test log extraction
 */

import fs from 'node:fs';
import path from 'node:path';

const ANSI_ESCAPE_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export const TOKEN_BUDGETS = Object.freeze({
  agentsMd: 600,
  copilotInstructions: 600,
  skillMd: 500,
  referenceMd: 800,
});

/**
 * Conservative token estimator shared across audit:solid, context-pack, and report-cloud:
 * max(words * 1.35, chars / 4).
 */
export function estimateTokens(text = '') {
  const s = String(text || '');
  const trimmed = s.trim();
  if (!trimmed) return 0;
  const words = trimmed.split(/\s+/).length;
  return Math.ceil(Math.max(words * 1.35, s.length / 4));
}

function walkMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdownFiles(full));
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out.sort();
}

/**
 * Computes sanitized static prompt & skill token footprint metrics for a repository.
 * Zero file contents, secrets, or paths beyond aggregate numbers are emitted.
 */
export function computeTokenFootprint(rootDir = process.cwd()) {
  const readTok = (relPath) => {
    const full = path.join(rootDir, relPath);
    return fs.existsSync(full) ? estimateTokens(fs.readFileSync(full, 'utf8')) : 0;
  };
  const agentsMdTokens = readTok('AGENTS.md');
  const copilotInstructionsTokens = readTok('.github/copilot-instructions.md');

  const skillsDir = path.join(rootDir, '.agents/skills');
  const mdFiles = walkMarkdownFiles(skillsDir);
  let skillCount = 0;
  let maxSkillTokens = 0;
  let totalSkillTokens = 0;
  let referenceCount = 0;
  let maxReferenceTokens = 0;
  let totalReferenceTokens = 0;
  let budgetViolations = 0;

  if (agentsMdTokens > TOKEN_BUDGETS.agentsMd) budgetViolations++;
  if (copilotInstructionsTokens > TOKEN_BUDGETS.copilotInstructions) budgetViolations++;

  for (const file of mdFiles) {
    const rel = path.relative(rootDir, file).replace(/\\/g, '/');
    const base = path.basename(file);
    const tok = estimateTokens(fs.readFileSync(file, 'utf8'));
    if (base === 'SKILL.md') {
      skillCount++;
      totalSkillTokens += tok;
      if (tok > maxSkillTokens) maxSkillTokens = tok;
      if (tok > TOKEN_BUDGETS.skillMd) budgetViolations++;
    } else if (rel.includes('/references/')) {
      if (base === 'local-overrides.md' || base === 'legacy-reference.md') continue;
      referenceCount++;
      totalReferenceTokens += tok;
      if (tok > maxReferenceTokens) maxReferenceTokens = tok;
      if (tok > TOKEN_BUDGETS.referenceMd) budgetViolations++;
    }
  }

  return {
    agentsMdTokens,
    copilotInstructionsTokens,
    totalAlwaysOnTokens: agentsMdTokens + copilotInstructionsTokens,
    skillCount,
    maxSkillTokens,
    totalSkillTokens,
    referenceCount,
    maxReferenceTokens,
    totalReferenceTokens,
    budgets: { ...TOKEN_BUDGETS },
    budgetsPassed: budgetViolations === 0,
  };
}

export function stripAnsi(text = '') {
  return String(text || '').replace(ANSI_ESCAPE_RE, '');
}

/**
 * Determines whether a CLI command should emit compact agent-facing output.
 *
 * Precedence:
 * 1. Explicit --verbose or --full => false
 * 2. Explicit --compact => true
 * 3. Env CORTEX_COMPACT=1 / true => true; CORTEX_COMPACT=0 / false => false
 * 4. Optional autoNonTty: when true and stdout is not a TTY => true
 */
export function isCompactMode(
  args = process.argv.slice(2),
  { env = process.env, stream = process.stdout, autoNonTty = true } = {}
) {
  const argSet = new Set(Array.isArray(args) ? args : []);
  if (argSet.has('--verbose') || argSet.has('--full')) return false;
  if (argSet.has('--compact')) return true;
  const envVal = String(env?.CORTEX_COMPACT ?? '').trim().toLowerCase();
  if (envVal === '1' || envVal === 'true') return true;
  if (envVal === '0' || envVal === 'false') return false;
  if (autoNonTty && stream && !stream.isTTY) return true;
  return false;
}

/**
 * Caps multi-line output to `maxLines` after stripping ANSI escapes and blank tail lines.
 */
export function capLines(text = '', { maxLines = 25, hint = 'pass --verbose for full output' } = {}) {
  const clean = stripAnsi(text).replace(/\r\n/g, '\n');
  const lines = clean.split('\n');
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
  while (lines.length > 0 && !lines[0].trim()) lines.shift();
  if (lines.length <= maxLines) return lines.join('\n');
  const omitted = lines.length - maxLines;
  return [...lines.slice(0, maxLines), `... (+${omitted} lines omitted; ${hint})`].join('\n');
}

/**
 * Truncates output to stay within an approximate token budget by dropping trailing lines.
 */
export function capToTokens(text = '', maxTokens = 400, hint = 'narrow scope or pass --full') {
  const clean = stripAnsi(text).replace(/\r\n/g, '\n');
  if (estimateTokens(clean) <= maxTokens) return clean;
  const lines = clean.split('\n');
  const budget = Math.max(8, Math.min(maxTokens, maxTokens - Math.min(16, Math.floor(maxTokens * 0.25))));
  if (lines.length === 1) {
    const maxChars = Math.max(16, budget * 4);
    return `${lines[0].slice(0, maxChars)}... (trimmed to <=${maxTokens} tok; ${hint})`;
  }
  const kept = [];
  for (const line of lines) {
    const candidate = kept.length > 0 ? `${kept.join('\n')}\n${line}` : line;
    if (estimateTokens(candidate) > budget && kept.length > 0) {
      const omitted = lines.length - kept.length;
      kept.push(`... (+${omitted} lines trimmed to <=${maxTokens} tok budget; ${hint})`);
      break;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Parses Playwright test stdout/stderr into a compact pass/fail summary with zero ANSI noise.
 */
export function summarizePlaywrightRun(stdout = '', stderr = '', { maxFailures = 5, maxErrorLines = 4 } = {}) {
  const cleanOut = stripAnsi(stdout);
  const cleanErr = stripAnsi(stderr);
  const combined = `${cleanOut}\n${cleanErr}`;

  const passedMatch = combined.match(/(\d+)\s+passed\b/);
  const failedMatch = combined.match(/(\d+)\s+failed\b/);
  const skippedMatch = combined.match(/(\d+)\s+skipped\b/);
  const passed = passedMatch ? Number(passedMatch[1]) : 0;
  const failed = failedMatch ? Number(failedMatch[1]) : 0;
  const skipped = skippedMatch ? Number(skippedMatch[1]) : 0;

  const failureBlocks = [];
  const lines = combined.split('\n');
  for (let i = 0; i < lines.length && failureBlocks.length < maxFailures; i++) {
    const line = lines[i].trim();
    // Match Playwright failure header like "1) [chromium] › tests/foo.spec.ts:12:5 › Title"
    if (/^\d+\)\s+\[/.test(line) || /^✖\s+/.test(line)) {
      const excerpt = [line];
      for (let j = i + 1; j < Math.min(lines.length, i + 18) && excerpt.length <= maxErrorLines; j++) {
        const sub = lines[j].trim();
        if (!sub) continue;
        if (/^\d+\)\s+\[/.test(sub)) break;
        if (
          /Error:|Timeout|expect\(|Received:|Expected:|waiting for|Locator:|error-context\.md|trace\.zip/i.test(sub)
        ) {
          excerpt.push(`   ${sub.slice(0, 180)}`);
        }
      }
      failureBlocks.push(excerpt.join('\n'));
    }
  }

  const errorContextPaths = [...new Set(combined.match(/test-results\/[^\s'"]+error-context\.md/g) || [])].slice(0, 3);

  return {
    passed,
    failed,
    skipped,
    failureBlocks,
    errorContextPaths,
    summaryLine: `${passed} passed${failed ? `, ${failed} failed` : ''}${skipped ? `, ${skipped} skipped` : ''}`,
  };
}

/**
 * Parses `node --test` output into a compact pass/fail summary with zero ANSI noise.
 */
export function summarizeNodeTestRun(stdout = '', stderr = '', { maxFailures = 5 } = {}) {
  const combined = stripAnsi(`${stdout}\n${stderr}`);
  const passMatch = combined.match(/ℹ\s+pass\s+(\d+)/) || combined.match(/# pass\s+(\d+)/);
  const failMatch = combined.match(/ℹ\s+fail\s+(\d+)/) || combined.match(/# fail\s+(\d+)/);
  const passed = passMatch ? Number(passMatch[1]) : 0;
  const failed = failMatch ? Number(failMatch[1]) : 0;

  const failingTests = [];
  const lines = combined.split('\n');
  for (let i = 0; i < lines.length && failingTests.length < maxFailures; i++) {
    const l = lines[i].trim();
    if (/^(?:✖|not ok\s+\d+)/.test(l)) {
      const detail = [];
      for (let j = i + 1; j < Math.min(lines.length, i + 12) && detail.length < 3; j++) {
        const sub = lines[j].trim();
        if (/AssertionError|Error:|expected|actual|message:/i.test(sub)) {
          detail.push(`   ${sub.slice(0, 180)}`);
        }
      }
      failingTests.push([l, ...detail].join('\n'));
    }
  }

  return {
    passed,
    failed,
    failingTests,
    summaryLine: `${passed} passed${failed ? `, ${failed} failed` : ''}`,
  };
}
