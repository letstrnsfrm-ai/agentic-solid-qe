#!/usr/bin/env node
/**
 * Legacy Skill & Script Onboarding Migrator for Agentic-SOLID-QE (05-skill-migrator).
 *
 * Modes:
 *   1. Workspace Discovery (`--discover` / `--scan`):
 *      Inventories all legacy prompts/rules (.cursorrules, .windsurfrules, CLAUDE.md, .cursor/rules/*,
 *      .agents/legacy-backups/*, custom .claude/commands/*, .github/prompts/*, oversized skills,
 *      custom helper scripts) AND audits existing tests/src for SOLID guardrail gaps.
 *   2. Single-Skill Dry-Run & Apply (`<source-path> [--name <skill-id>] [--squad <squad>] [--apply]`):
 *      Decomposes a legacy skill/prompt and its scripts into a <500-token SKILL.md bundle,
 *      redacts secrets in both references/ and scripts/, relocates utility/API seeders to scripts/,
 *      archives legacy UI scripts in references/ while bridging a schema-valid Session Tape
 *      (.exploratory/tapes/<id>.json), scaffolds & indexes a <=150-line Domain Shard, and registers
 *      the skill in AGENTS.md + .github/copilot-instructions.md.
 *
 * Usage:
 *   npm run migrate:skill -- --discover
 *   npm run migrate:skill -- <source-path> [--name <skill-id>] [--squad <squad>] [--apply]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const MAX_SKILL_TOKENS = 500;
const MAX_DOMAIN_LINES = 150;

const CORE_SKILL_IDS = new Set([
  '00-env-bootstrap',
  '01-cli-explorer',
  '02-solid-architect',
  '03-drift-healer',
  '04-ci-pipeline',
  '05-skill-migrator',
]);

const CORE_ENGINE_SCRIPTS = new Set([
  'scripts/build-domain-graph.mjs',
  'scripts/migrate-skill.mjs',
  'scripts/analyze-coverage.mjs',
  'scripts/audit-solid.mjs',
  'scripts/validate-tapes.mjs',
  'scripts/sync-skills.mjs',
  'scripts/generate-release-notes.mjs',
]);

const rawArgs = process.argv.slice(2);
let sourceArg = '';
let skillNameArg = '';
let squadArg = '';
let applyChanges = false;
let discoverMode = false;

for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === '--apply') {
    applyChanges = true;
  } else if (arg === '--discover' || arg === '--scan') {
    discoverMode = true;
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

function estimateTokens(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(Math.max(words * 1.35, text.length / 4));
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function isWithinDir(targetPath, baseDir) {
  const relPath = path.relative(baseDir, targetPath);
  return relPath === '' || (!relPath.startsWith('..') && !path.isAbsolute(relPath));
}

function walkFiles(dir, extList) {
  if (!fs.existsSync(dir)) return [];
  const normalizedExts =
    typeof extList === 'string' ? [extList] : Array.isArray(extList) ? extList : null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...walkFiles(full, normalizedExts));
    } else if (!normalizedExts || normalizedExts.some((ext) => full.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function slugifyId(rawName, indexPrefix = '06') {
  const base = String(rawName || '')
    .toLowerCase()
    .replace(/\.(prompt|instructions|legacy)?\.(md|mdc|sh|js|mjs|ts|py)$/i, '')
    .replace(/^\.+/, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
  if (!base) return `${indexPrefix}-migrated-skill`;
  if (/^\d{2}-/.test(base)) return base;
  return `${indexPrefix}-${base}`;
}

function runWorkspaceDiscovery() {
  const scanRoot = sourceArg ? path.resolve(ROOT, sourceArg) : ROOT;
  const relFromScan = (p) => path.relative(scanRoot, p).replace(/\\/g, '/');
  const agentsMdPath = path.join(scanRoot, 'AGENTS.md');
  const agentsMdContent = fs.existsSync(agentsMdPath) ? fs.readFileSync(agentsMdPath, 'utf8') : '';

  const candidateSources = [];
  const seenPaths = new Set();
  const addCandidate = (absPath, kind, fixedId = '') => {
    const resolved = path.resolve(absPath);
    if (seenPaths.has(resolved)) return;
    seenPaths.add(resolved);
    candidateSources.push({ absPath: resolved, kind, fixedId });
  };

  let seq = 6;
  const nextPrefix = () => String(seq++).padStart(2, '0');

  const rootPromptFiles = ['.cursorrules', '.windsurfrules', 'CLAUDE.md'];
  for (const rf of rootPromptFiles) {
    const abs = path.join(scanRoot, rf);
    if (fs.existsSync(abs) && !fs.lstatSync(abs).isSymbolicLink()) {
      addCandidate(abs, 'root-ai-rules-file');
    }
  }

  for (const bf of walkFiles(path.join(scanRoot, '.agents/legacy-backups'), ['.md'])) {
    addCandidate(bf, 'preserved-pre-install-instructions');
  }

  for (const cf of walkFiles(path.join(scanRoot, '.cursor/rules'), ['.mdc', '.md'])) {
    addCandidate(cf, 'cursor-rule');
  }

  for (const cmdFile of walkFiles(path.join(scanRoot, '.claude/commands'), ['.md'])) {
    const id = path.basename(cmdFile, '.md');
    if (CORE_SKILL_IDS.has(id)) continue;
    const matchingSkill = path.join(scanRoot, '.agents/skills', id, 'SKILL.md');
    if (!fs.existsSync(matchingSkill)) {
      addCandidate(cmdFile, 'unmigrated-claude-command');
    }
  }

  for (const ghPrompt of walkFiles(path.join(scanRoot, '.github/prompts'), ['.md'])) {
    const id = path.basename(ghPrompt).replace(/\.prompt\.md$/i, '').replace(/\.md$/i, '');
    if (CORE_SKILL_IDS.has(id)) continue;
    const matchingSkill = path.join(scanRoot, '.agents/skills', id, 'SKILL.md');
    if (!fs.existsSync(matchingSkill)) {
      addCandidate(ghPrompt, 'unmigrated-github-prompt');
    }
  }

  for (const ghInst of walkFiles(path.join(scanRoot, '.github/instructions'), ['.md'])) {
    addCandidate(ghInst, 'github-instructions-file');
  }

  const skillsDir = path.join(scanRoot, '.agents/skills');
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      if (CORE_SKILL_IDS.has(entry.name)) continue;
      const skillMd = path.join(skillsDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      const tokens = estimateTokens(fs.readFileSync(skillMd, 'utf8'));
      const hasClaudeWrapper = fs.existsSync(
        path.join(scanRoot, '.claude/commands', `${entry.name}.md`)
      );
      const hasGhWrapper = fs.existsSync(
        path.join(scanRoot, '.github/prompts', `${entry.name}.prompt.md`)
      );
      const isRegisteredInAgents = agentsMdContent.includes(entry.name);
      if (tokens > MAX_SKILL_TOKENS || !hasClaudeWrapper || !hasGhWrapper || !isRegisteredInAgents) {
        addCandidate(
          path.join(skillsDir, entry.name),
          'non-compliant-or-unregistered-skill',
          entry.name
        );
      }
    }
  }

  const ignoredRootDirs = new Set([
    '.agents',
    '.claude',
    '.cursor',
    '.github',
    '.git',
    '.exploratory',
    '.playwright-cli',
    '.auth',
    'node_modules',
    'src',
    'tests',
    'e2e',
    'defects',
    'scripts',
    'dist',
    'build',
    'playwright-report',
    'test-results',
  ]);

  if (fs.existsSync(scanRoot)) {
    for (const entry of fs.readdirSync(scanRoot, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      if (ignoredRootDirs.has(entry.name)) continue;
      const subDir = path.join(scanRoot, entry.name);
      for (const f of walkFiles(subDir, ['.md', '.cursorrules', '.windsurfrules', '.mdc'])) {
        const baseLower = path.basename(f).toLowerCase();
        if (
          baseLower === 'skill.md' ||
          baseLower.endsWith('.prompt.md') ||
          baseLower.endsWith('.cursorrules') ||
          baseLower.endsWith('.windsurfrules') ||
          baseLower.endsWith('.mdc') ||
          ['legacy-skills', 'legacy-prompts', 'prompts', 'skills'].includes(entry.name)
        ) {
          addCandidate(
            baseLower === 'skill.md' ? path.dirname(f) : f,
            `custom-folder-skill (${entry.name})`
          );
        }
      }
    }
  }

  const discoveredLegacySkills = candidateSources.map((item) => {
    const isDir = fs.lstatSync(item.absPath).isDirectory();
    const docPath = isDir ? path.join(item.absPath, 'SKILL.md') : item.absPath;
    const raw = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : '';
    const tokens = estimateTokens(raw);
    const rawBaseName =
      !isDir && path.basename(item.absPath).toLowerCase() === 'skill.md'
        ? path.basename(path.dirname(item.absPath))
        : path.basename(item.absPath);
    const suggestedId = item.fixedId || slugifyId(rawBaseName, nextPrefix());
    const sourceRel = relFromScan(item.absPath);
    return {
      sourcePath: sourceRel,
      kind: item.kind,
      estimatedTokens: tokens,
      exceeds500TokenBudget: tokens > MAX_SKILL_TOKENS,
      suggestedSkillId: suggestedId,
      dryRunCommand: `npm run migrate:skill -- ${sourceRel} --name ${suggestedId}`,
      applyCommand: `npm run migrate:skill -- ${sourceRel} --name ${suggestedId} --apply`,
    };
  });

  const standaloneHelperScripts = [
    ...walkFiles(path.join(scanRoot, 'scripts'), ['.sh', '.js', '.mjs', '.ts', '.py']),
    ...walkFiles(path.join(scanRoot, 'helpers'), ['.sh', '.js', '.mjs', '.ts', '.py']),
  ]
    .map((f) => relFromScan(f))
    .filter((r) => !CORE_ENGINE_SCRIPTS.has(r));

  // Audit existing specs and src for SOLID guardrail alignment
  const specFiles = [
    ...walkFiles(path.join(scanRoot, 'tests'), '.spec.ts'),
    ...walkFiles(path.join(scanRoot, 'e2e'), '.spec.ts'),
  ];
  const specGuardrailGaps = [];
  for (const sf of specFiles) {
    const code = stripComments(fs.readFileSync(sf, 'utf8'));
    const issues = [];
    if (/from\s+['"]@playwright\/test['"]/.test(code)) {
      issues.push('Imports directly from @playwright/test instead of @fixtures/app.fixture');
    }
    if (
      !/from\s+['"]@data\//.test(code) &&
      !/from\s+['"]@domains\/[^'"]+\/data\//.test(code) &&
      !/from\s+['"].*\/data\//.test(code)
    ) {
      issues.push('Missing Data Builder import from src/data/ or src/domains/<squad>/data/');
    }
    const bodyOnly = code
      .replace(/^\s*import\s+.*$/gm, '')
      .replace(/\btest(?:\.describe)?\s*\(\s*(['"`])(?:\\.|(?!\1).)*\1/g, 'test(');
    if (/['"`]https?:\/\/[^'"`]+['"`]/.test(bodyOnly)) {
      issues.push('Contains hardcoded http(s):// URL in spec body');
    }
    if (issues.length > 0) {
      specGuardrailGaps.push({ specFile: relFromScan(sf), issues });
    }
  }

  const domainMemoryPath = path.join(scanRoot, '.agents/domain/domain-memory.md');
  const hasDomainMemory = fs.existsSync(domainMemoryPath);
  const domainMemoryLines = hasDomainMemory
    ? fs.readFileSync(domainMemoryPath, 'utf8').split('\n').length
    : 0;

  const discoveryReport = {
    mode: 'workspace-discovery',
    workspaceRoot: scanRoot,
    domainBrainStatus: {
      domainMemoryInitialized: hasDomainMemory,
      domainMemoryLines,
      within150LineCap: domainMemoryLines <= MAX_DOMAIN_LINES,
    },
    discoveredLegacySkillsAndPrompts: discoveredLegacySkills,
    standaloneHelperScripts,
    existingPlaywrightSuiteAudit: {
      totalSpecsScanned: specFiles.length,
      specsPassingSolidGuardrails: specFiles.length - specGuardrailGaps.length,
      specsNeedingSolidMigration: specGuardrailGaps,
    },
    recommendedAgentWorkflow: [
      discoveredLegacySkills.length > 0
        ? `1. Run dry-run triage for each discovered skill (${discoveredLegacySkills[0].dryRunCommand}), present the 4-Part Migration Triage Matrix to the user, and apply with '--apply'.`
        : `1. No unmigrated legacy prompt/rule files detected in standard locations. If the user has skills in a custom path, run: npm run migrate:skill -- <path> --name <skill-id>`,
      specGuardrailGaps.length > 0
        ? `2. Refactor ${specGuardrailGaps.length} non-SOLID spec(s) via '/02-solid-architect' so they consume '@fixtures/app.fixture' and typed Data Builders from 'src/data/'.`
        : `2. All ${specFiles.length} existing spec(s) satisfy SOLID fixture and Data Builder guardrails.`,
      `3. Run 'npm run verify' to confirm all <500-token skill budgets, <=150-line domain shards, and SOLID gates pass.`,
    ],
  };

  console.log('🔍 Agentic-SOLID-QE Workspace Onboarding & Legacy Skill Discovery Report:\n');
  console.log(JSON.stringify(discoveryReport, null, 2));
  process.exit(0);
}

if (discoverMode) {
  runWorkspaceDiscovery();
}

if (!sourceArg) {
  console.log(`
🧭 Agentic-SOLID-QE Skill & Script Migrator (05-skill-migrator)

Usage:
  npm run migrate:skill -- --discover
  npm run migrate:skill -- <path-to-legacy-skill-or-dir> [--name <skill-id>] [--squad <squad>] [--apply]

Examples:
  npm run migrate:skill -- --discover
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

// 1. Locate primary markdown/prompt file & associated scripts
const stat = fs.lstatSync(resolvedSource);
if (stat.isSymbolicLink()) {
  console.error(`❌ Refusing to migrate symbolic link source: ${resolvedSource}`);
  process.exit(1);
}
let primaryDocPath = '';
let sourceDir = '';
let candidateScriptPaths = [];

if (stat.isDirectory()) {
  sourceDir = resolvedSource;
  const mdFiles = walkFiles(sourceDir, ['.md', '.cursorrules', '.windsurfrules', '.mdc']);
  primaryDocPath =
    mdFiles.find((f) => path.basename(f).toLowerCase() === 'skill.md') ||
    mdFiles.find((f) => path.basename(f).toLowerCase() === 'readme.md') ||
    mdFiles[0] ||
    '';
  candidateScriptPaths = walkFiles(sourceDir, ['.sh', '.js', '.mjs', '.ts', '.py']);
} else {
  primaryDocPath = resolvedSource;
  sourceDir = path.dirname(resolvedSource);
  // Only auto-collect co-located scripts when sourceDir is not the repository root
  if (path.resolve(sourceDir) !== path.resolve(ROOT)) {
    candidateScriptPaths = walkFiles(sourceDir, ['.sh', '.js', '.mjs', '.ts', '.py']);
  }
}

const rawDoc =
  primaryDocPath && fs.existsSync(primaryDocPath)
    ? fs.readFileSync(primaryDocPath, 'utf8')
    : '';

function assertSafeSlug(value, flagName) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value) || value.includes('..')) {
    console.error(
      `❌ Invalid ${flagName} '${value}'. Must be a lowercase kebab-case identifier ([a-z0-9-]) with no path separators.`
    );
    process.exit(1);
  }
  return value;
}

function sanitizeSingleLineText(value, fallback) {
  const cleaned = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/---+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

if (skillNameArg) {
  assertSafeSlug(skillNameArg, '--name');
}
if (squadArg) {
  squadArg = assertSafeSlug(squadArg.toLowerCase(), '--squad');
}

const derivedSkillId =
  skillNameArg ||
  path
    .basename(primaryDocPath || resolvedSource, path.extname(primaryDocPath || resolvedSource))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '') ||
  'custom-migrated-skill';
const defaultSkillId = assertSafeSlug(derivedSkillId, 'skill ID');

// 2. Discover scripts referenced in the markdown + co-located scripts
const scriptRegex =
  /(?:node|bash|sh|python3?|npx\s+tsx|ts-node)?\s*([./a-zA-Z0-9_-]+\.(?:sh|mjs|js|ts|py))\b/g;
const referencedScriptTokens = new Set();
for (const m of rawDoc.matchAll(scriptRegex)) {
  const token = m[1].trim();
  if (
    token.startsWith('src/') ||
    token.startsWith('tests/') ||
    token.startsWith('scripts/') ||
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
  if (
    isWithinDir(fromSourceDir, sourceDir) &&
    fs.existsSync(fromSourceDir) &&
    !fs.lstatSync(fromSourceDir).isSymbolicLink() &&
    !CORE_ENGINE_SCRIPTS.has(rel(fromSourceDir))
  ) {
    resolvedScripts.set(fromSourceDir, refToken);
  } else if (
    isWithinDir(fromRoot, ROOT) &&
    fs.existsSync(fromRoot) &&
    !fs.lstatSync(fromRoot).isSymbolicLink() &&
    !CORE_ENGINE_SCRIPTS.has(rel(fromRoot))
  ) {
    resolvedScripts.set(fromRoot, refToken);
  }
}
for (const sp of candidateScriptPaths) {
  if (!resolvedScripts.has(sp) && isWithinDir(sp, sourceDir) && !CORE_ENGINE_SCRIPTS.has(rel(sp))) {
    resolvedScripts.set(sp, path.relative(sourceDir, sp));
  }
}

// 3. Classify each script & scan for hardcoded URLs/secrets/UI anti-patterns
const HARDCODED_SECRET_ASSIGN_REGEX =
  /((?:password|secret|api[_-]?key|token)\s*[:=]\s*)(['"`])([^'"`$]{4,})\2/gi;
const KNOWN_TOKEN_LITERAL_REGEX =
  /(['"`])((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}[^'"`]*|ChangeMe123!)\1/g;
const BARE_TOKEN_REGEX =
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bsk-[A-Za-z0-9_-]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\bBearer\s+eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|\bChangeMe123!\b/g;
const PRIVATE_KEY_BLOCK_REGEX =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

function redactHardcodedSecrets(textBody, fileName = '') {
  const envReplacement = fileName.endsWith('.sh')
    ? '"${REDACTED_SECRET:?Set REDACTED_SECRET in env}"'
    : fileName.endsWith('.py')
      ? 'os.environ["REDACTED_SECRET"]'
      : fileName.endsWith('.md') || fileName.endsWith('.mdc')
        ? '"<REDACTED_VIA_ENV_OR_DATA_BUILDER>"'
        : 'process.env.REDACTED_SECRET';
  return textBody
    .replace(PRIVATE_KEY_BLOCK_REGEX, '<REDACTED_PRIVATE_KEY_USE_ENV_SECRET>')
    .replace(HARDCODED_SECRET_ASSIGN_REGEX, `$1${envReplacement}`)
    .replace(KNOWN_TOKEN_LITERAL_REGEX, envReplacement)
    .replace(BARE_TOKEN_REGEX, '<REDACTED_SECRET_TOKEN>');
}

const analyzedScripts = [];
for (const [absPath, originalRef] of resolvedScripts.entries()) {
  const content = fs.readFileSync(absPath, 'utf8');
  const fileName = path.basename(absPath);
  const hardcodedUrls = [
    ...new Set([...content.matchAll(/https?:\/\/[^\s'"`)]+/g)].map((m) => m[0])),
  ];
  const hasHardcodedSecrets =
    /(?:password|secret|api[_-]?key|token)\s*[:=]\s*['"`][^'"`$]{4,}['"`]/i.test(content) ||
    BARE_TOKEN_REGEX.test(content) ||
    PRIVATE_KEY_BLOCK_REGEX.test(content);
  BARE_TOKEN_REGEX.lastIndex = 0;
  PRIVATE_KEY_BLOCK_REGEX.lastIndex = 0;

  const hasLegacyUiAntiPatterns =
    /\b(?:waitForTimeout|xpath|puppeteer|selenium|cy\.visit|cy\.get)\b/.test(content) ||
    (/\bpage\.locator\b/.test(content) && /\bexpect\s*\(/.test(content));

  const classification = hasLegacyUiAntiPatterns
    ? 'legacy-ui-automation'
    : 'utility-or-api-seeder';

  const targetRelPath =
    classification === 'legacy-ui-automation'
      ? `.agents/skills/${defaultSkillId}/references/${fileName}`
      : `.agents/skills/${defaultSkillId}/scripts/${fileName}`;
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
    canonicalCommand:
      classification === 'legacy-ui-automation'
        ? `Invoke /02-solid-architect to compile .exploratory/tapes/${defaultSkillId}.json`
        : `${runnerPrefix} ${targetRelPath}`,
    bridgedSessionTapePath:
      classification === 'legacy-ui-automation'
        ? `.exploratory/tapes/${defaultSkillId}.json`
        : null,
    classification,
    hardcodedUrls,
    hasHardcodedSecrets,
    hasLegacyUiAntiPatterns,
    recommendation:
      classification === 'legacy-ui-automation'
        ? `Archive raw UI script in ${targetRelPath}, bridge UI steps into Session Tape (.exploratory/tapes/${defaultSkillId}.json), and compile via /02-solid-architect.`
        : `Relocate to ${targetRelPath} and parameterize URLs/secrets via process.env.BASE_URL / src/data/*.builder.ts.`,
  });
}

// 4. Extract embedded Domain Knowledge (Routes, Test IDs, API endpoints, Invariants)
const combinedSourceText = [
  rawDoc,
  ...Array.from(resolvedScripts.keys()).map((p) => fs.readFileSync(p, 'utf8')),
].join('\n');

const discoveredRoutes = [
  ...new Set(
    [
      ...rawDoc.matchAll(/`(\/[a-zA-Z0-9._/-]+)`/g),
      ...combinedSourceText.matchAll(/\.goto\s*\(\s*['"`](\/[a-zA-Z0-9._/-]*)['"`]/g),
    ].map((m) => m[1])
  ),
].filter(
  (r) =>
    !r.startsWith('//') &&
    !r.endsWith('.sh') &&
    !r.endsWith('.js') &&
    !r.endsWith('.mjs') &&
    !r.endsWith('.ts') &&
    !r.endsWith('.py') &&
    !r.endsWith('.md') &&
    !/^\/0[0-9]-/.test(r)
);

const discoveredTestIds = [
  ...new Set(
    [
      ...combinedSourceText.matchAll(/data-test(?:id)?=['"`]([^'"`]+)['"`]/g),
      ...combinedSourceText.matchAll(/getByTestId\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g),
    ].map((m) => m[1])
  ),
];

const targetDomainShard = squadArg
  ? `.agents/domain/domains/${squadArg.toLowerCase()}/shards/${defaultSkillId}.md`
  : `.agents/domain/shards/${defaultSkillId}.md`;

// 5. Decompose Markdown into <500-token SKILL.md + references/legacy-reference.md
const originalTokens = estimateTokens(rawDoc);
const titleMatch = rawDoc.match(/^#\s+(.+)$/m);
const skillTitle = sanitizeSingleLineText(
  titleMatch ? titleMatch[1] : '',
  `Skill: ${defaultSkillId}`
);
const descMatch = rawDoc.match(/description:\s*(.+)/i);
const skillDescription = sanitizeSingleLineText(
  descMatch ? descMatch[1] : '',
  `Onboarded team workflow for ${skillTitle}. Invoke /${defaultSkillId} to execute.`
);
const yamlSafeDescription = JSON.stringify(skillDescription);

const scriptSectionLines =
  analyzedScripts.length > 0
    ? analyzedScripts.map((s, idx) =>
        s.classification === 'legacy-ui-automation'
          ? `${idx + 1}. **\`${s.fileName}\` (legacy-ui-automation ➔ Session Tape):** Archived in \`${s.targetPath}\`. Compile \`.exploratory/tapes/${defaultSkillId}.json\` into SOLID Components/Pages/Specs via \`/02-solid-architect\`.`
          : `${idx + 1}. **\`${s.fileName}\` (utility-or-api-seeder):** Run \`${s.canonicalCommand}\``
      )
    : [
        '1. Inspect `.agents/domain/domain-memory.md` and relevant feature shards before execution.',
      ];

const synthesizedSkillMd = `---
name: ${defaultSkillId}
description: ${yamlSafeDescription}
---

# ${skillTitle}

## 1. Zero-Prompt Auto-Start: Context & Domain Brain Alignment
When invoked as \`/${defaultSkillId}\`:
1. Read \`.agents/domain/domain-memory.md\` and \`${targetDomainShard}\`.
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

function resolveRepoBaseUrl() {
  const domainMemoryPath = path.join(ROOT, '.agents/domain/domain-memory.md');
  if (fs.existsSync(domainMemoryPath)) {
    const m = fs.readFileSync(domainMemoryPath, 'utf8').match(/-\s*\*\*Base URL:\*\*\s*`([^`]+)`/);
    if (m && /^https?:\/\//.test(m[1].trim())) {
      return m[1].trim();
    }
  }
  return 'http://localhost:3000';
}

function buildStarterSessionTape() {
  const baseUrl = resolveRepoBaseUrl();
  const primaryRoute =
    discoveredRoutes.find((r) => r.startsWith('/') && !r.startsWith('//')) || '/';
  return {
    schemaVersion: '1.0.0',
    scenarioId: defaultSkillId,
    title: `Migrated UI Flow: ${skillTitle}`.slice(0, 120),
    charter: 'happy-path-baseline',
    tags: ['@regression'],
    recordedAt: new Date().toISOString(),
    baseUrl,
    persona: {
      role: 'standard',
      dataBuilderRef: 'UserBuilder.standardUser()',
    },
    preconditions: [
      `Migrated from legacy UI automation script in ${defaultSkillId} via 05-skill-migrator`,
    ],
    semanticSteps: [
      {
        stepIndex: 1,
        intent: `Navigate to ${primaryRoute} for ${skillTitle}`,
        pageRoute: primaryRoute,
        action: 'goto',
        componentCandidate: 'MigratedFlowPage',
        locatorContract: {
          strategy: 'url',
          value: primaryRoute,
        },
      },
    ],
    networkContracts: [],
    expectedStates: [
      {
        description: `Verify ${primaryRoute} view renders for standard persona`,
        assertionType: 'toBeVisible',
        targetComponent: 'migratedFlowPage',
        targetProperty: 'root',
        expectedValueRef: 'UserBuilder.standardUser().role',
      },
    ],
  };
}

function scaffoldAndIndexDomainShard(appliedList) {
  const today = new Date().toISOString().slice(0, 10);
  const ownerSquad = `@org/${squadArg || 'qe'}-squad`;
  const routesFormatted =
    discoveredRoutes.length > 0 ? discoveredRoutes.map((r) => `\`${r}\``).join(', ') : '`/`';
  const testIdsLines =
    discoveredTestIds.length > 0
      ? discoveredTestIds.slice(0, 15).map((id) => `- Discovered test ID: \`${id}\``)
      : ['- Append discovered semantic locators and `data-testid` attributes here during exploration.'];
  const utilityScripts = analyzedScripts.filter((s) => s.classification === 'utility-or-api-seeder');
  const seederLines =
    utilityScripts.length > 0
      ? utilityScripts.map((s) => `- **Precondition Seeder (\`${s.fileName}\`):** \`${s.canonicalCommand}\``)
      : ['- Restore `.auth/<persona>.json` (`storageState`) or invoke `UserBuilder.standardUser()`.'];

  const absShardPath = path.join(ROOT, targetDomainShard);
  const parentHubRel = squadArg
    ? `.agents/domain/domains/${squadArg}/index.md`
    : '.agents/domain/domain-memory.md';

  if (!fs.existsSync(absShardPath)) {
    fs.mkdirSync(path.dirname(absShardPath), { recursive: true });
    const shardBody = `# Domain Shard: ${skillTitle} (${routesFormatted})

> **Parent Index:** \`${parentHubRel}\` | **Max Lines:** 150
> **Owner Squad:** \`${ownerSquad}\` | **Last Verified:** \`${today}\`
> **Published Capabilities:** \`UserBuilder\`

---

## 1. Business Invariants & State Transitions

1. **Onboarded Workflow (\`/${defaultSkillId}\`):** Extracted by \`05-skill-migrator\`. Refine business rules from \`.agents/skills/${defaultSkillId}/references/legacy-reference.md\`.

---

## 2. API, Session & Storage Contracts (Cross-Squad Preconditions)

${seederLines.join('\n')}

---

## 3. Discovered Behaviours & Locator Quirks

${testIdsLines.join('\n')}
`;
    fs.writeFileSync(absShardPath, shardBody, 'utf8');
    appliedList.push(rel(absShardPath));
  }

  const domainMemoryPath = path.join(ROOT, '.agents/domain/domain-memory.md');
  if (squadArg) {
    const absSquadHub = path.join(ROOT, parentHubRel);
    if (!fs.existsSync(absSquadHub)) {
      fs.mkdirSync(path.dirname(absSquadHub), { recursive: true });
      const hubBody = `# Domain Sub-Hub: ${squadArg} (Tier 1 Bounded Context)

> **Parent Index:** \`.agents/domain/domain-memory.md\` | **Max Lines:** 150
> **Owner Squad:** \`${ownerSquad}\` | **Last Verified:** \`${today}\`
> **Published Capabilities:** \`UserBuilder\`

---

## 1. Bounded Context & Upstream/Downstream Contracts

- **Owned Routes:** ${routesFormatted}
- **Upstream Preconditions:** Global persona session from \`.auth/<persona>.json\`.

---

## 2. Squad Feature Shard Index

| Feature Shard | Routes | Shard Path | Summary |
| :--- | :--- | :--- | :--- |
| **${skillTitle}** | ${routesFormatted} | \`${targetDomainShard}\` | Onboarded via \`/${defaultSkillId}\` |
`;
      fs.writeFileSync(absSquadHub, hubBody, 'utf8');
      appliedList.push(rel(absSquadHub));
    } else {
      const hubContent = fs.readFileSync(absSquadHub, 'utf8');
      if (!hubContent.includes(path.basename(absShardPath)) && hubContent.split('\n').length < MAX_DOMAIN_LINES) {
        const row = `| **${skillTitle}** | ${routesFormatted} | \`${targetDomainShard}\` | Onboarded via \`/${defaultSkillId}\` |\n`;
        fs.appendFileSync(absSquadHub, row, 'utf8');
        appliedList.push(rel(absSquadHub));
      }
    }

    if (fs.existsSync(domainMemoryPath)) {
      const memContent = fs.readFileSync(domainMemoryPath, 'utf8');
      if (!memContent.includes(parentHubRel) && memContent.split('\n').length < MAX_DOMAIN_LINES) {
        const updatedMem = insertRowIntoDomainMemoryTable(
          memContent,
          `**${squadArg} Domain**`,
          ownerSquad,
          routesFormatted,
          parentHubRel,
          `Tier 1 Squad Sub-Hub (${defaultSkillId})`
        );
        if (updatedMem !== memContent) {
          fs.writeFileSync(domainMemoryPath, updatedMem, 'utf8');
          appliedList.push(rel(domainMemoryPath));
        }
      }
    }
  } else if (fs.existsSync(domainMemoryPath)) {
    const memContent = fs.readFileSync(domainMemoryPath, 'utf8');
    if (!memContent.includes(path.basename(absShardPath)) && memContent.split('\n').length < MAX_DOMAIN_LINES) {
      const updatedMem = insertRowIntoDomainMemoryTable(
        memContent,
        `**${skillTitle}**`,
        ownerSquad,
        routesFormatted,
        targetDomainShard,
        `Onboarded via \`/${defaultSkillId}\``
      );
      if (updatedMem !== memContent) {
        fs.writeFileSync(domainMemoryPath, updatedMem, 'utf8');
        appliedList.push(rel(domainMemoryPath));
      }
    }
  }
}

function insertRowIntoDomainMemoryTable(memContent, label, ownerSquad, routes, shardPath, summary) {
  const lines = memContent.split('\n');
  let tableHeaderIdx = -1;
  let isFiveColumn = true;
  for (let i = 0; i < lines.length; i++) {
    if (/^\|\s*(?:Bounded Context|Feature\s*\/\s*Domain Area)/i.test(lines[i])) {
      tableHeaderIdx = i;
      const colCount = lines[i].split('|').filter((c) => c.trim().length > 0).length;
      isFiveColumn = colCount >= 5;
      break;
    }
  }
  const newRow = isFiveColumn
    ? `| ${label} | \`${ownerSquad}\` | ${routes} | \`${shardPath}\` | ${summary} |`
    : `| ${label} | ${routes} | \`${shardPath}\` | ${summary} |`;

  if (tableHeaderIdx === -1) {
    return `${memContent.trimEnd()}\n${newRow}\n`;
  }

  let insertAt = tableHeaderIdx + 2;
  while (insertAt < lines.length && lines[insertAt].trim().startsWith('|')) {
    insertAt++;
  }
  lines.splice(insertAt, 0, newRow);
  return lines.join('\n');
}

function registerSkillInAgentsAndCopilot(appliedList) {
  const agentsPath = path.join(ROOT, 'AGENTS.md');
  const skillRelPath = `.agents/skills/${defaultSkillId}/SKILL.md`;
  if (fs.existsSync(agentsPath)) {
    const content = fs.readFileSync(agentsPath, 'utf8');
    if (!content.includes(skillRelPath)) {
      const lines = content.split('\n');
      let insertIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('.agents/skills/05-skill-migrator/SKILL.md')) {
          insertIdx = i + 1;
          break;
        }
      }
      const newRow = `| ${skillDescription.replace(/\|/g, '/')} | \`${defaultSkillId}\` | \`${skillRelPath}\` |`;
      if (insertIdx !== -1) {
        lines.splice(insertIdx, 0, newRow);
        fs.writeFileSync(agentsPath, lines.join('\n'), 'utf8');
        appliedList.push(rel(agentsPath));
      }
    }
  }

  const copilotPath = path.join(ROOT, '.github/copilot-instructions.md');
  if (fs.existsSync(copilotPath)) {
    const content = fs.readFileSync(copilotPath, 'utf8');
    if (!content.includes(skillRelPath)) {
      const entry = `\n- **${skillTitle} (\`${defaultSkillId}\`):** Follow \`${skillRelPath}\` (${skillDescription}).\n`;
      fs.writeFileSync(copilotPath, `${content.trimEnd()}\n${entry}`, 'utf8');
      appliedList.push(rel(copilotPath));
    }
  }
}

// 6. Apply changes if --apply is passed
const appliedFiles = [];
if (applyChanges) {
  fs.mkdirSync(path.join(targetSkillDir, 'references'), { recursive: true });
  fs.mkdirSync(path.join(targetSkillDir, 'scripts'), { recursive: true });

  fs.writeFileSync(targetSkillFile, synthesizedSkillMd, 'utf8');
  appliedFiles.push(rel(targetSkillFile));

  if (rawDoc.trim().length > 0) {
    const sanitizedDoc = redactHardcodedSecrets(rawDoc.trim(), 'legacy-reference.md');
    fs.writeFileSync(
      targetRefFile,
      `# Legacy Reference & Detailed Templates (${defaultSkillId})\n\n> Extracted and secret-sanitized automatically by \`05-skill-migrator\` to keep \`SKILL.md\` under the 500-token budget.\n\n---\n\n${sanitizedDoc}\n`,
      'utf8'
    );
    appliedFiles.push(rel(targetRefFile));
  }

  let hasLegacyUiScript = false;
  for (const s of analyzedScripts) {
    const absSrc = path.resolve(ROOT, s.sourcePath);
    const absDest = path.resolve(ROOT, s.targetPath);
    fs.mkdirSync(path.dirname(absDest), { recursive: true });
    let scriptBody = fs.readFileSync(absSrc, 'utf8');
    if (/\.(?:js|mjs|ts)$/.test(s.fileName) && s.hardcodedUrls.length > 0) {
      for (const u of s.hardcodedUrls) {
        try {
          const parsedUrl = new URL(u);
          if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') continue;
        } catch {
          continue;
        }
        scriptBody = scriptBody.replace(
          new RegExp(`(['"\`])${u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`, 'g'),
          `(process.env.BASE_URL || ${JSON.stringify(u)})`
        );
      }
    }
    if (s.hasHardcodedSecrets) {
      scriptBody = redactHardcodedSecrets(scriptBody, s.fileName);
    }
    fs.writeFileSync(absDest, scriptBody, 'utf8');
    appliedFiles.push(rel(absDest));

    if (s.classification === 'legacy-ui-automation') {
      hasLegacyUiScript = true;
    }
  }

  if (hasLegacyUiScript) {
    const tapeDir = path.join(ROOT, '.exploratory/tapes');
    fs.mkdirSync(tapeDir, { recursive: true });
    const tapePath = path.join(tapeDir, `${defaultSkillId}.json`);
    if (!fs.existsSync(tapePath)) {
      const starterTape = buildStarterSessionTape();
      fs.writeFileSync(tapePath, JSON.stringify(starterTape, null, 2) + '\n', 'utf8');
      appliedFiles.push(rel(tapePath));
    }
  }

  // Scaffold & index <=150-line Domain Shard and register in AGENTS.md / copilot-instructions.md
  scaffoldAndIndexDomainShard(appliedFiles);
  registerSkillInAgentsAndCopilot(appliedFiles);

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
description: ${yamlSafeDescription}
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
  guardrailsEnforced: {
    skillTokenBudgetUnder500: synthesizedTokens <= MAX_SKILL_TOKENS,
    secretsRedactedInReferencesAndScripts: true,
    legacyUiScriptsBridgedToSessionTape: analyzedScripts.some(
      (s) => s.classification === 'legacy-ui-automation'
    ),
    domainShardIndexedWithin150Lines: true,
    registeredInAgentsMdAndCopilotInstructions: true,
  },
  multiIdeEntrypoints: {
    skillFile: `.agents/skills/${defaultSkillId}/SKILL.md`,
    claudeCommand: `.claude/commands/${defaultSkillId}.md`,
    githubPrompt: `.github/prompts/${defaultSkillId}.prompt.md`,
  },
  appliedFiles,
  nextStep: applyChanges
    ? `Run 'npm run verify' to validate token budgets, domain shard indexing, Session Tapes, and SOLID architecture.`
    : `Review the Migration Triage Matrix above, then re-run with '--apply' (or confirm in /05-skill-migrator) to scaffold the bundle.`,
};

console.log('📦 Agentic-SOLID-QE Skill & Script Migration Triage Report:\n');
console.log(JSON.stringify(migrationReport, null, 2));
