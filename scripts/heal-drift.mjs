#!/usr/bin/env node
/**
 * Deterministic Drift-Healer CLI (`npx cortex heal`).
 *
 * Capabilities:
 *   1. Parses Playwright failure artifacts (`test-results/<run>/error-context.md`, `playwright-report/results.json`)
 *      or explicit `--spec` / `--error` inputs alongside `.playwright-cli/page-*.yml` snapshots.
 *   2. Classifies failures into Auth Drift, Genuine App Regression (never weakening `expect()`),
 *      or UI/Locator Drift.
 *   3. Scores YAML snapshot candidates against the broken locator & Component property.
 *   4. With `--apply`, writes `defects/DEFECT-*.md` for regressions or safely patches high-confidence
 *      (or `--to`-specified) Component locators & Session Tapes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_FILE_BYTES = 1024 * 1024;
const HIGH_CONFIDENCE_THRESHOLD = 0.65;

function isWithinDir(targetPath, baseDir) {
  const rel = path.relative(baseDir, targetPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function readTextSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return '';
    const st = fs.lstatSync(filePath);
    if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_FILE_BYTES) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function walkFiles(dir, predicate) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git'].includes(entry.name)) continue;
      out.push(...walkFiles(full, predicate));
    } else if (predicate(entry.name, full)) {
      out.push(full);
    }
  }
  return out;
}

function tokenize(raw) {
  return String(raw || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !['get', 'by', 'role', 'name', 'exact', 'true', 'false', 'locator', 'page', 'root', 'this'].includes(t));
}

function slugifyKebab(raw) {
  return String(raw || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-') || 'defect';
}

function escapeSingleQuote(val) {
  return String(val || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Parse `@playwright/cli` YAML snapshot lines into structured accessible nodes.
 */
export function parsePlaywrightSnapshotYaml(yamlText) {
  const nodes = [];
  const lines = String(yamlText || '').split('\n');
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith('- ')) continue;

    // Example: - button "Sign In" [ref=e14]
    // Example: - textbox "Email Address" [ref=e12]
    // Example: - link "Order History" [ref=e5]
    const match = trimmed.match(/^-\s+([a-zA-Z0-9_-]+)(?:\s+"([^"]*)")?(.*)$/);
    if (!match) continue;

    const role = match[1].toLowerCase();
    const name = (match[2] || '').trim();
    const attrs = match[3] || '';
    const refMatch = attrs.match(/\bref=([^,\]]+)/);
    const testIdMatch = attrs.match(/\[data-test(?:id)?=["']?([^\]"']+)["']?\]/);

    if (!name && !testIdMatch) continue;
    nodes.push({
      role,
      name,
      ref: refMatch ? refMatch[1] : null,
      testId: testIdMatch ? testIdMatch[1] : null,
      rawLine: trimmed,
    });
  }
  return nodes;
}

/**
 * Extract failing locator expression from Playwright error text.
 */
export function extractFailingLocatorFromError(errorText) {
  const text = String(errorText || '');
  const patterns = [
    /waiting for (?:locator\(['"`]([^'"`]+)['"`]\)|([a-zA-Z0-9_.]+\([^)]*\)))/i,
    /Locator:\s*([^\n]+)/i,
    /(getBy(?:Role|TestId|Label|Placeholder|Text)\([^)]+\))/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      return (m[1] || m[2] || '').trim();
    }
  }
  return '';
}

/**
 * Discover Playwright failure artifacts under `test-results/`.
 */
export function parseErrorContextArtifacts(projectRoot) {
  const testResultsDir = path.join(projectRoot, 'test-results');
  const errorFiles = walkFiles(testResultsDir, (name) => name === 'error-context.md');
  const artifacts = [];

  for (const file of errorFiles) {
    const content = readTextSafe(file);
    if (!content) continue;
    const specMatch = content.match(/(?:Test|Spec|File):\s*([^\n]+)/i);
    artifacts.push({
      file: path.relative(projectRoot, file).replace(/\\/g, '/'),
      specPath: specMatch ? specMatch[1].trim() : null,
      errorText: content,
      failingLocator: extractFailingLocatorFromError(content),
    });
  }
  return artifacts;
}

/**
 * Classify root cause using the 8-way differential matrix.
 */
export function classifyFailureRootCause({
  errorText = '',
  consoleErrors = [],
  httpStatuses = [],
  snapshotUrl = '',
  specPath = '',
}) {
  const err = String(errorText || '');
  const has401or403 =
    /\b(?:401|403|unauthorized|forbidden)\b/i.test(err) ||
    httpStatuses.some((s) => s === 401 || s === 403);
  const redirectedToLogin =
    /\/(?:login|signin|sso)\b/i.test(snapshotUrl) && !/login|auth/i.test(String(specPath || ''));

  if (has401or403 || redirectedToLogin) {
    return {
      category: 'auth-drift',
      caseId: 4,
      summary: 'Expired or rejected .auth/<persona>.json session (401/403 or redirect to login).',
      neverWeakenAssertions: true,
    };
  }

  const has5xx =
    /(?:HTTP|status|statusCode|responded with)\s*:?\s*50[0-4]\b/i.test(err) ||
    httpStatuses.some((s) => s >= 500 && s < 600);
  const isAssertionMismatch =
    /\b(?:Expected|Received):/i.test(err) &&
    !/TimeoutError.*waiting for/i.test(err);

  if (has5xx || (consoleErrors.length > 0 && isAssertionMismatch) || isAssertionMismatch) {
    return {
      category: 'app-regression',
      caseId: has5xx ? 6 : 7,
      summary: has5xx
        ? 'First-party 5xx API/server error detected during test execution.'
        : 'Assertion value mismatch (business logic or state regression) — preserve strict expect().',
      neverWeakenAssertions: true,
    };
  }

  return {
    category: 'locator-drift',
    caseId: 1,
    summary: 'UI / Locator drift detected (TimeoutError / missing selector with clean console & API).',
    neverWeakenAssertions: true,
  };
}

function nodeToPlaywrightExpr(node) {
  if (node.testId) {
    return {
      expr: `getByTestId('${escapeSingleQuote(node.testId)}')`,
      locatorContract: { strategy: 'getByTestId', value: node.testId, nameExact: true },
    };
  }
  const semanticRoles = new Set([
    'button',
    'link',
    'textbox',
    'checkbox',
    'radio',
    'combobox',
    'heading',
    'tab',
    'menuitem',
  ]);
  if (semanticRoles.has(node.role) && node.name) {
    return {
      expr: `getByRole('${node.role}', { name: '${escapeSingleQuote(node.name)}', exact: true })`,
      locatorContract: {
        strategy: 'getByRole',
        role: node.role,
        value: node.name,
        nameExact: true,
      },
    };
  }
  return {
    expr: `getByText('${escapeSingleQuote(node.name)}', { exact: true })`,
    locatorContract: { strategy: 'getByText', value: node.name, nameExact: true },
  };
}

/**
 * Score YAML snapshot nodes against the failing locator and Component property name.
 */
export function scoreSnapshotCandidates(failingLocator, propertyName, snapshotNodes) {
  const queryTokens = new Set([
    ...tokenize(failingLocator),
    ...tokenize(propertyName),
  ]);
  const roleHintMatch = String(failingLocator || '').match(/getByRole\(['"]([a-z]+)['"]/i);
  const roleHint = roleHintMatch
    ? roleHintMatch[1].toLowerCase()
    : /btn|button|submit|save|cancel/i.test(propertyName)
      ? 'button'
      : /input|field|textbox/i.test(propertyName)
        ? 'textbox'
        : /link|nav/i.test(propertyName)
          ? 'link'
          : null;

  const scored = [];
  for (const node of snapshotNodes) {
    const nodeTokens = new Set([...tokenize(node.name), ...tokenize(node.testId || '')]);
    let overlap = 0;
    for (const t of queryTokens) {
      if (nodeTokens.has(t)) overlap++;
      else {
        for (const nt of nodeTokens) {
          if (nt.includes(t) || t.includes(nt)) {
            overlap += 0.6;
            break;
          }
        }
      }
    }

    const tokenScore = queryTokens.size > 0 ? Math.min(1, overlap / Math.max(1, Math.min(queryTokens.size, nodeTokens.size || 1))) : 0;
    const roleScore = roleHint && node.role === roleHint ? 0.35 : roleHint ? 0 : 0.15;
    const confidence = Number(Math.min(0.99, tokenScore * 0.65 + roleScore).toFixed(2));
    const { expr, locatorContract } = nodeToPlaywrightExpr(node);

    scored.push({
      node,
      confidence,
      suggestedExpr: expr,
      suggestedLocatorContract: locatorContract,
    });
  }

  scored.sort((a, b) => b.confidence - a.confidence);
  return scored;
}

function findMatchingComponentProperty(projectRoot, failingLocator, specPath) {
  const componentFiles = [
    ...walkFiles(path.join(projectRoot, 'src/components'), (n) => n.endsWith('.component.ts')),
    ...walkFiles(path.join(projectRoot, 'src/domains'), (n) => n.endsWith('.component.ts')),
  ];

  const locTokens = tokenize(failingLocator);
  for (const file of componentFiles) {
    const content = readTextSafe(file);
    if (!content) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*this\.([a-zA-Z0-9_]+)\s*=\s*(?:this\.root|page)\.(.+);\s*$/);
      if (!m) continue;
      const propName = m[1];
      const rhs = m[2];
      const exactMatch = failingLocator && rhs.includes(failingLocator);
      const tokenMatch =
        locTokens.length > 0 &&
        locTokens.every((t) => rhs.toLowerCase().includes(t) || propName.toLowerCase().includes(t));

      if (exactMatch || tokenMatch) {
        return {
          filePath: file,
          relPath: path.relative(projectRoot, file).replace(/\\/g, '/'),
          propertyName: propName,
          lineIndex: i,
          currentExpr: rhs,
          prefix: lines[i].includes('this.root.') ? 'this.root.' : 'page.',
        };
      }
    }
  }
  return null;
}

function findMatchingTape(projectRoot, specPath, failingLocator) {
  const tapesDir = path.join(projectRoot, '.exploratory/tapes');
  const tapeFiles = walkFiles(tapesDir, (n) => n.endsWith('.json'));
  const specBase = specPath ? path.basename(specPath, '.spec.ts') : '';

  for (const file of tapeFiles) {
    const raw = readTextSafe(file);
    if (!raw) continue;
    try {
      const tape = JSON.parse(raw);
      if (specBase && tape.scenarioId === specBase) {
        return { filePath: file, relPath: path.relative(projectRoot, file).replace(/\\/g, '/'), tape };
      }
      const locTokens = tokenize(failingLocator);
      if (
        locTokens.length > 0 &&
        Array.isArray(tape.semanticSteps) &&
        tape.semanticSteps.some((s) =>
          locTokens.every((t) => JSON.stringify(s.locatorContract || {}).toLowerCase().includes(t))
        )
      ) {
        return { filePath: file, relPath: path.relative(projectRoot, file).replace(/\\/g, '/'), tape };
      }
    } catch {
      /* skip malformed tape */
    }
  }
  return null;
}

function findLatestSnapshot(projectRoot, explicitSnapshot) {
  if (explicitSnapshot) {
    const resolved = path.resolve(projectRoot, explicitSnapshot);
    return isWithinDir(resolved, projectRoot) && fs.existsSync(resolved) ? resolved : null;
  }
  const candidates = [];
  for (const dirName of ['.agent-browser', '.playwright-cli']) {
    const dirPath = path.join(projectRoot, dirName);
    candidates.push(...walkFiles(dirPath, (n) => n.endsWith('.yml') || n.endsWith('.yaml') || n.endsWith('.txt')));
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0];
}

/**
 * Analyze a failing test / artifact and optionally apply safe healing or defect logging.
 */
export function analyzeAndHealDrift(projectRoot, options = {}) {
  const artifacts = parseErrorContextArtifacts(projectRoot);
  const activeArtifact = artifacts[0] || {};
  const errorText = options.error || activeArtifact.errorText || '';
  const specPath = options.spec || activeArtifact.specPath || '';
  const failingLocator = options.locator || extractFailingLocatorFromError(errorText) || activeArtifact.failingLocator || '';

  const snapshotFile = findLatestSnapshot(projectRoot, options.snapshot);
  const snapshotText = snapshotFile ? readTextSafe(snapshotFile) : '';
  const snapshotNodes = parsePlaywrightSnapshotYaml(snapshotText);

  const rootCause = classifyFailureRootCause({
    errorText,
    consoleErrors: options.consoleErrors || [],
    httpStatuses: options.httpStatuses || [],
    snapshotUrl: options.snapshotUrl || '',
    specPath,
  });

  const componentMatch = findMatchingComponentProperty(projectRoot, failingLocator, specPath);
  const tapeMatch = findMatchingTape(projectRoot, specPath, failingLocator);

  const candidates =
    rootCause.category === 'locator-drift'
      ? scoreSnapshotCandidates(failingLocator, componentMatch?.propertyName || '', snapshotNodes)
      : [];

  const topCandidate = candidates[0] || null;
  const secondCandidate = candidates[1] || null;
  const hasClearWinner =
    topCandidate &&
    topCandidate.confidence >= HIGH_CONFIDENCE_THRESHOLD &&
    (!secondCandidate || topCandidate.confidence - secondCandidate.confidence >= 0.1);

  const result = {
    status: 'diagnosed',
    rootCause,
    specPath: specPath || null,
    failingLocator: failingLocator || null,
    snapshotUsed: snapshotFile ? path.relative(projectRoot, snapshotFile).replace(/\\/g, '/') : null,
    componentMatch: componentMatch
      ? { file: componentMatch.relPath, property: componentMatch.propertyName, currentExpr: componentMatch.currentExpr }
      : null,
    tapeMatch: tapeMatch ? { file: tapeMatch.relPath, scenarioId: tapeMatch.tape.scenarioId } : null,
    candidates: candidates.slice(0, 3).map((c) => ({
      role: c.node.role,
      name: c.node.name,
      confidence: c.confidence,
      suggestedExpr: c.suggestedExpr,
    })),
    autoHealReady: Boolean(options.to || (rootCause.category === 'locator-drift' && hasClearWinner)),
    appliedChanges: [],
    defectFile: null,
  };

  if (!options.apply) {
    return result;
  }

  // Apply phase
  if (rootCause.category === 'auth-drift') {
    result.status = 'auth-refresh-required';
    result.nextCommand = 'npx playwright test --project=setup';
    return result;
  }

  if (rootCause.category === 'app-regression') {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const slug = slugifyKebab(specPath ? path.basename(specPath, '.spec.ts') : 'app-regression');
    const defectRel = `defects/DEFECT-${ts}-${slug}.md`;
    const defectFull = path.join(projectRoot, defectRel);
    if (!isWithinDir(defectFull, projectRoot)) {
      throw new Error(`Refusing to write defect outside project root: ${defectFull}`);
    }
    fs.mkdirSync(path.dirname(defectFull), { recursive: true });
    fs.writeFileSync(
      defectFull,
      [
        `# Defect Report: ${slug}`,
        ``,
        `- **Detected By:** \`npx cortex heal\``,
        `- **Root Cause Category:** Case ${rootCause.caseId} (${rootCause.category})`,
        `- **Spec:** \`${specPath || 'unknown'}\``,
        `- **Summary:** ${rootCause.summary}`,
        ``,
        `## Error Excerpt`,
        `\`\`\``,
        errorText.slice(0, 1200),
        `\`\`\``,
        ``,
        `## Guardrail Note`,
        `Strict \`expect()\` assertions in the spec were preserved (never weakened).`,
        ``,
      ].join('\n'),
      'utf8'
    );
    result.status = 'defect-logged';
    result.defectFile = defectRel;
    return result;
  }

  // Locator drift apply
  const replacementExpr = options.to || (hasClearWinner ? topCandidate.suggestedExpr : null);
  if (!replacementExpr) {
    result.status = 'needs-human-review';
    return result;
  }

  if (componentMatch) {
    if (!isWithinDir(componentMatch.filePath, projectRoot)) {
      throw new Error(`Refusing to patch component outside project root: ${componentMatch.filePath}`);
    }
    const compLines = fs.readFileSync(componentMatch.filePath, 'utf8').split('\n');
    const cleanExpr = replacementExpr.replace(/^(?:page|this\.root)\./, '');
    compLines[componentMatch.lineIndex] = `    this.${componentMatch.propertyName} = ${componentMatch.prefix}${cleanExpr};`;
    fs.writeFileSync(componentMatch.filePath, compLines.join('\n'), 'utf8');
    result.appliedChanges.push(componentMatch.relPath);
  }

  if (tapeMatch && topCandidate && !options.to) {
    if (!isWithinDir(tapeMatch.filePath, projectRoot)) {
      throw new Error(`Refusing to patch tape outside project root: ${tapeMatch.filePath}`);
    }
    const locTokens = tokenize(failingLocator);
    const updated = { ...tapeMatch.tape };
    let patchedStep = false;
    if (Array.isArray(updated.semanticSteps)) {
      updated.semanticSteps = updated.semanticSteps.map((step) => {
        if (
          !patchedStep &&
          locTokens.length > 0 &&
          locTokens.every((t) => JSON.stringify(step.locatorContract || {}).toLowerCase().includes(t))
        ) {
          patchedStep = true;
          return {
            ...step,
            locatorContract: {
              ...topCandidate.suggestedLocatorContract,
            },
          };
        }
        return step;
      });
    }
    if (patchedStep) {
      fs.writeFileSync(tapeMatch.filePath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
      result.appliedChanges.push(tapeMatch.relPath);
    }
  }

  result.status = result.appliedChanges.length > 0 ? 'healed' : 'needs-human-review';
  return result;
}

// CLI execution
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
🩹 Cortex Drift-Healer CLI (npx cortex heal)

Usage:
  npx cortex heal [--spec <path>] [--error <msg>] [--snapshot <yml>] [--to <locator>] [--apply] [--json]
`);
    process.exit(0);
  }

  const getArg = (flag) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
  };

  const res = analyzeAndHealDrift(process.cwd(), {
    spec: getArg('--spec'),
    error: getArg('--error'),
    snapshot: getArg('--snapshot'),
    to: getArg('--to'),
    apply: args.includes('--apply'),
  });

  if (args.includes('--json')) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(`\n🩹 Cortex Drift-Healer (${res.status}):\n`);
    console.log(JSON.stringify(res, null, 2));
  }
}
