#!/usr/bin/env node
/**
 * Legacy Skill & Script Onboarding Migrator for Agentic-SOLID-QE (05-skill-migrator).
 *
 * Scans an unorganized skill/prompt file (.md, .cursorrules, .prompt.md) or directory,
 * discovers its invoked scripts (.sh, .js, .mjs, .ts, .py), classifies utility vs. legacy UI scripts,
 * extracts embedded domain facts for the 3-Tier Organizational Brain, splits oversized docs into
 * references/, rewrites fragile relative script paths, and scaffolds a <500-token SKILL.md bundle
 * with .claude/commands and .github/prompts wrappers.
 *
 * Usage:
 *   npm run migrate:skill -- <source-path> [--name <skill-id>] [--squad <squad>] [--apply]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const MAX_SKILL_TOKENS = 500;

const rawArgs = process.argv.slice(2);
let sourceArg = '';
let skillNameArg = '';
let squadArg = '';
let applyChanges = false;

for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === '--apply') {
    applyChanges = true;
  } else if (arg === '--name' && rawArgs[i + 1]) {
    skillNameArg = rawArgs[++i];
  } else if (arg.startsWith('--name=')) {
    skillNameArg = arg.slice('--name='.length);
  } else if (arg === '--squad' && rawArgs[i + 1]) {
    squadArg = rawArgs[++i];
  } else if (arg.startsWith('--squad=')) {
    squadArg = arg.slice('--squad='.length);
  } else if (!arg.startsWith('-') && !sourceArg) {
    sourceArg = arg;
  }
}

if (!sourceArg) {
  console.log(`
🧭 Agentic-SOLID-QE Skill & Script Migrator (05-skill-migrator)

Usage:
  npm run migrate:skill -- <path-to-legacy-skill-or-dir> [--name <skill-id>] [--squad <squad>] [--apply]

Examples:
  npm run migrate:skill -- ./legacy-prompts/checkout-helper.md --name 06-checkout-seeder --squad checkout
  npm run migrate:skill -- ./old-team-skills/api-sync/ --name 06-api-sync --apply

Starter Guide:
  See .agents/skills/05-skill-migrator/references/migration-starter-guide.md
`);
  process.exit(0);
}

const resolvedSource = path.resolve(ROOT, sourceArg);
if (!fs.existsSync(resolvedSource)) {
  console.error(`❌ Source path not found: ${resolvedSource}`);
  process.exit(1);
}

function estimateTokens(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(Math.max(words * 1.35, text.length / 4));
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function walkFiles(dir, extList) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...walkFiles(full, extList));
    } else if (!extList || extList.some((ext) => full.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

// 1. Locate primary markdown/prompt file & associated scripts
const stat = fs.statSync(resolvedSource);
let primaryDocPath = '';
let sourceDir = '';
let candidateScriptPaths = [];

if (stat.isDirectory()) {
  sourceDir = resolvedSource;
  const mdFiles = walkFiles(sourceDir, ['.md', '.cursorrules', '.windsurfrules']);
  primaryDocPath =
    mdFiles.find((f) => path.basename(f).toLowerCase() === 'skill.md') ||
    mdFiles.find((f) => path.basename(f).toLowerCase() === 'readme.md') ||
    mdFiles[0] ||
    '';
  candidateScriptPaths = walkFiles(sourceDir, ['.sh', '.js', '.mjs', '.ts', '.py']);
} else {
  primaryDocPath = resolvedSource;
  sourceDir = path.dirname(resolvedSource);
  candidateScriptPaths = walkFiles(sourceDir, ['.sh', '.js', '.mjs', '.ts', '.py']);
}

const rawDoc = primaryDocPath && fs.existsSync(primaryDocPath)
  ? fs.readFileSync(primaryDocPath, 'utf8')
  : '';

const defaultSkillId =
  skillNameArg ||
  path
    .basename(primaryDocPath || resolvedSource, path.extname(primaryDocPath || resolvedSource))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-|-$/g, '') ||
  'custom-migrated-skill';

// 2. Discover scripts referenced in the markdown + co-located scripts
const scriptRegex = /(?:node|bash|sh|python3?|npx\s+tsx|ts-node)?\s*([./a-zA-Z0-9_-]+\.(?:sh|mjs|js|ts|py))\b/g;
const referencedScriptTokens = new Set();
for (const m of rawDoc.matchAll(scriptRegex)) {
  const token = m[1].trim();
  if (
    token.startsWith('src/') ||
    token.startsWith('tests/') ||
    token.endsWith('.spec.ts') ||
    token.endsWith('.builder.ts') ||
    token.endsWith('.component.ts') ||
    token.endsWith('.page.ts') ||
    token.endsWith('.contract.ts') ||
    token.endsWith('.fixture.ts') ||
    token === 'playwright.config.ts'
  ) {
    continue;
  }
  referencedScriptTokens.add(token);
}

const resolvedScripts = new Map();
for (const refToken of referencedScriptTokens) {
  const fromSourceDir = path.resolve(sourceDir, refToken);
  const fromRoot = path.resolve(ROOT, refToken);
  if (fs.existsSync(fromSourceDir)) {
    resolvedScripts.set(fromSourceDir, refToken);
  } else if (fs.existsSync(fromRoot)) {
    resolvedScripts.set(fromRoot, refToken);
  }
}
for (const sp of candidateScriptPaths) {
  if (!resolvedScripts.has(sp)) {
    resolvedScripts.set(sp, path.relative(sourceDir, sp));
  }
}

// 3. Classify each script & scan for hardcoded URLs/secrets/UI anti-patterns
const analyzedScripts = [];
for (const [absPath, originalRef] of resolvedScripts.entries()) {
  const content = fs.readFileSync(absPath, 'utf8');
  const fileName = path.basename(absPath);
  const hardcodedUrls = [...new Set([...content.matchAll(/https?:\/\/[^\s'"`)]+/g)].map((m) => m[0]))];
  const hasHardcodedSecrets = /(?:password|secret|api[_-]?key|token)\s*[:=]\s*['"`][^'"`$]{4,}['"`]/i.test(
    content
  );
  const hasLegacyUiAntiPatterns =
    /\b(?:waitForTimeout|xpath|puppeteer|selenium|cy\.visit|cy\.get)\b/.test(content) ||
    (/\bpage\.locator\b/.test(content) && /\bexpect\s*\(/.test(content));

  const classification = hasLegacyUiAntiPatterns
    ? 'legacy-ui-automation'
    : 'utility-or-api-seeder';

  const targetRelPath = `.agents/skills/${defaultSkillId}/scripts/${fileName}`;
  const runnerPrefix = fileName.endsWith('.sh')
    ? 'bash'
    : fileName.endsWith('.py')
      ? 'python3'
      : 'node';

  analyzedScripts.push({
    fileName,
    sourcePath: rel(absPath),
    originalReference: originalRef,
    targetPath: targetRelPath,
    canonicalCommand: `${runnerPrefix} ${targetRelPath}`,
    classification,
    hardcodedUrls,
    hasHardcodedSecrets,
    hasLegacyUiAntiPatterns,
    recommendation:
      classification === 'legacy-ui-automation'
        ? `Bridge UI steps into a validated Session Tape (.exploratory/tapes/${defaultSkillId}.json) and compile via /02-solid-architect instead of running raw UI script.`
        : `Relocate to ${targetRelPath} and parameterize URLs/secrets via process.env.BASE_URL / src/data/*.builder.ts.`,
  });
}

// 4. Extract embedded Domain Knowledge (Routes, Test IDs, API endpoints, Invariants)
const discoveredRoutes = [
  ...new Set([...rawDoc.matchAll(/`(\/[a-zA-Z0-9._/-]+)`/g)].map((m) => m[1])),
].filter(
  (r) =>
    !r.endsWith('.sh') &&
    !r.endsWith('.js') &&
    !r.endsWith('.md') &&
    !/^\/0[0-9]-/.test(r)
);

const discoveredTestIds = [
  ...new Set(
    [...rawDoc.matchAll(/data-test(?:id)?=['"`]([^'"`]+)['"`]/g)].map((m) => m[1])
  ),
];

const targetDomainShard = squadArg
  ? `.agents/domain/domains/${squadArg.toLowerCase()}/shards/${defaultSkillId}.md`
  : `.agents/domain/shards/${defaultSkillId}.md`;

// 5. Decompose Markdown into <500-token SKILL.md + references/legacy-reference.md
const originalTokens = estimateTokens(rawDoc);
const titleMatch = rawDoc.match(/^#\s+(.+)$/m);
const skillTitle = titleMatch ? titleMatch[1].trim() : `Skill: ${defaultSkillId}`;
const descMatch = rawDoc.match(/description:\s*(.+)/i);
const skillDescription = descMatch
  ? descMatch[1].trim()
  : `Onboarded team workflow for ${skillTitle}. Invoke /${defaultSkillId} to execute.`;

const scriptSectionLines =
  analyzedScripts.length > 0
    ? analyzedScripts.map(
        (s, idx) =>
          `${idx + 1}. **\`${s.fileName}\` (${s.classification}):** Run \`${s.canonicalCommand}\``
      )
    : ['1. Inspect `.agents/domain/domain-memory.md` and relevant feature shards before execution.'];

const synthesizedSkillMd = `---
name: ${defaultSkillId}
description: ${skillDescription}
---

# ${skillTitle}

## 1. Zero-Prompt Auto-Start: Context & Domain Brain Alignment
When invoked as \`/${defaultSkillId}\`:
1. Read \`.agents/domain/domain-memory.md\` (and \`${targetDomainShard}\` if present).
2. Review detailed legacy reference templates in \`.agents/skills/${defaultSkillId}/references/legacy-reference.md\`.

## 2. Standardized Script & Workflow Execution
${scriptSectionLines.join('\n')}

## 3. SOLID & Verification Gate
1. Record any newly discovered routes, API contracts, or locator quirks in \`${targetDomainShard}\` (≤ 150 lines).
2. Never place \`expect()\` inside \`src/components/\` or \`src/pages/\`.
3. Run \`npm run verify\` to confirm all SOLID, tape, and domain memory checks pass.
`;

const synthesizedTokens = estimateTokens(synthesizedSkillMd);
const targetSkillDir = path.join(ROOT, '.agents/skills', defaultSkillId);
const targetSkillFile = path.join(targetSkillDir, 'SKILL.md');
const targetRefFile = path.join(targetSkillDir, 'references/legacy-reference.md');

// 6. Apply changes if --apply is passed
const appliedFiles = [];
if (applyChanges) {
  fs.mkdirSync(path.join(targetSkillDir, 'references'), { recursive: true });
  fs.mkdirSync(path.join(targetSkillDir, 'scripts'), { recursive: true });

  fs.writeFileSync(targetSkillFile, synthesizedSkillMd, 'utf8');
  appliedFiles.push(rel(targetSkillFile));

  if (rawDoc.trim().length > 0) {
    fs.writeFileSync(
      targetRefFile,
      `# Legacy Reference & Detailed Templates (${defaultSkillId})\n\n> Extracted automatically by \`05-skill-migrator\` to keep \`SKILL.md\` under the 500-token budget.\n\n---\n\n${rawDoc.trim()}\n`,
      'utf8'
    );
    appliedFiles.push(rel(targetRefFile));
  }

  // Copy and sanitize utility scripts
  for (const s of analyzedScripts) {
    const absSrc = path.resolve(ROOT, s.sourcePath);
    const absDest = path.resolve(ROOT, s.targetPath);
    let scriptBody = fs.readFileSync(absSrc, 'utf8');
    // Sanitize hardcoded http(s) URLs in JS/TS/MJS scripts to use process.env.BASE_URL fallback
    if (/\.(?:js|mjs|ts)$/.test(s.fileName) && s.hardcodedUrls.length > 0) {
      for (const u of s.hardcodedUrls) {
        scriptBody = scriptBody.replace(
          new RegExp(`(['"\`])${u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`, 'g'),
          `(process.env.BASE_URL || '${u}')`
        );
      }
    }
    fs.writeFileSync(absDest, scriptBody, 'utf8');
    appliedFiles.push(rel(absDest));
  }

  // Generate .claude/commands/<skill-id>.md and .github/prompts/<skill-id>.prompt.md
  const claudeCmdPath = path.join(ROOT, '.claude/commands', `${defaultSkillId}.md`);
  fs.mkdirSync(path.dirname(claudeCmdPath), { recursive: true });
  fs.writeFileSync(
    claudeCmdPath,
    `Activate \`.agents/skills/${defaultSkillId}/SKILL.md\` and execute its **Zero-Prompt Auto-Start** workflow (read \`.agents/domain/domain-memory.md\` ➔ run standardized scripts in \`.agents/skills/${defaultSkillId}/scripts/\` ➔ update domain shard \`${targetDomainShard}\` ➔ verify via \`npm run verify\`). $ARGUMENTS\n`,
    'utf8'
  );
  appliedFiles.push(rel(claudeCmdPath));

  const ghPromptPath = path.join(ROOT, '.github/prompts', `${defaultSkillId}.prompt.md`);
  fs.mkdirSync(path.dirname(ghPromptPath), { recursive: true });
  fs.writeFileSync(
    ghPromptPath,
    `---
mode: agent
description: ${skillDescription}
---
Activate \`.agents/skills/${defaultSkillId}/SKILL.md\` and execute its **Zero-Prompt Auto-Start** workflow (read \`.agents/domain/domain-memory.md\` ➔ run standardized scripts in \`.agents/skills/${defaultSkillId}/scripts/\` ➔ update domain shard \`${targetDomainShard}\` ➔ verify via \`npm run verify\`).\n`,
    'utf8'
  );
  appliedFiles.push(rel(ghPromptPath));
}

const migrationReport = {
  mode: applyChanges ? 'applied' : 'dry-run-preview',
  sourceInspected: rel(resolvedSource),
  targetSkillId: defaultSkillId,
  tokenBudgetAudit: {
    originalTokens,
    exceededBudget: originalTokens > MAX_SKILL_TOKENS,
    synthesizedSkillTokens: synthesizedTokens,
    maxAllowedTokens: MAX_SKILL_TOKENS,
    extractedReferencePath: `.agents/skills/${defaultSkillId}/references/legacy-reference.md`,
  },
  discoveredScripts: analyzedScripts,
  extractedDomainKnowledge: {
    targetDomainShard,
    discoveredRoutes,
    discoveredTestIds,
  },
  multiIdeEntrypoints: {
    skillFile: `.agents/skills/${defaultSkillId}/SKILL.md`,
    claudeCommand: `.claude/commands/${defaultSkillId}.md`,
    githubPrompt: `.github/prompts/${defaultSkillId}.prompt.md`,
  },
  appliedFiles,
  nextStep: applyChanges
    ? `Run 'npm run verify' to validate token budgets and SOLID architecture.`
    : `Review the Migration Triage Matrix above, then re-run with '--apply' (or confirm in /05-skill-migrator) to scaffold the bundle.`,
};

console.log('📦 Agentic-SOLID-QE Skill & Script Migration Triage Report:\n');
console.log(JSON.stringify(migrationReport, null, 2));
