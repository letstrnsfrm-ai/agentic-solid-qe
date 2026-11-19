#!/usr/bin/env node
/**
 * High-Speed Exploration Orchestrator & Live Session Tape Recorder (`npx cortex explore`).
 *
 * Bridges Point-A prerequisite reuse (`--from-spec` + `--until-step`, `--from-seed`, or
 * `<1s` `--checkpoint` restore) -> automatic free-port CDP attach -> batched `agent-browser`
 * actions with auto-semantic-locator resolution, compact `-i` snapshot deltas, secret/PII
 * redaction, multi-actor portal switching, and 1-command `finish --compile` into SOLID specs.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = process.cwd();

const EXPLORATORY_DIR = path.join(ROOT, '.exploratory');
const CHECKPOINTS_DIR = path.join(EXPLORATORY_DIR, 'checkpoints');
const TAPES_DIR = path.join(EXPLORATORY_DIR, 'tapes');
const LIVE_SESSION_FILE = path.join(EXPLORATORY_DIR, 'live-session.json');
const RELEASE_SENTINEL_FILE = path.join(EXPLORATORY_DIR, 'live-session.release');
const LIVE_STATE_FILE = path.join(EXPLORATORY_DIR, 'live-explore-state.json');
const LIVE_DRAFT_TAPE_FILE = path.join(EXPLORATORY_DIR, 'live-draft-tape.json');

const SAFE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const SENSITIVE_FIELD_RE = /(pass(word|code)?|secret|token|api[-_]?key|ssn|social|cvv|cvc|card|pin|otp|mfa|auth)/i;
const SENSITIVE_VALUE_RE = /^(sk_|pk_|ghp_|gho_|Bearer\s+|eyJ[A-Za-z0-9_-]+\.|[0-9]{3}-[0-9]{2}-[0-9]{4}|(?:\d[ -]*?){13,16})$/;

// ─── Pure Exported Helpers (Unit-Testable) ──────────────────────────────────

export function validateSafeId(val, label = 'id') {
  if (typeof val !== 'string' || !SAFE_ID_RE.test(val)) {
    throw new Error(`Invalid ${label} '${val}'. Must match ^[a-z0-9][a-z0-9-]*$.`);
  }
  return val;
}

export function resolveConfinedPath(rootDir, relPath, allowedPrefix, label = 'path') {
  if (typeof relPath !== 'string' || !relPath.trim() || path.isAbsolute(relPath) || relPath.includes('..')) {
    throw new Error(`Unsafe ${label} '${relPath}'. Must be a relative path under ${allowedPrefix}.`);
  }
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized.startsWith(allowedPrefix)) {
    throw new Error(`Unsafe ${label} '${relPath}'. Must stay confined under '${allowedPrefix}'.`);
  }
  const base = path.resolve(rootDir, allowedPrefix);
  const resolved = path.resolve(rootDir, normalized);
  const rel = path.relative(base, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path traversal detected for ${label}: '${relPath}'.`);
  }
  return { absPath: resolved, relPath: normalized };
}

export function findFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 9222;
      server.close(() => resolve(port));
    });
  });
}

export function parseSnapshotRefs(snapshotText = '') {
  const refMap = new Map();
  for (const rawLine of String(snapshotText).split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // Format 1: `- button "Sign In" [ref=e5]` or `- textbox "Email" [ref=e2]`
    let m = line.match(/^-\s+([a-zA-Z0-9_-]+)(?:\s+"([^"]*)")?.*?\[ref=(e\d+)\]/);
    if (m) {
      refMap.set(`@${m[3]}`, { role: m[1].toLowerCase(), name: m[2] || '', rawLine: line });
      continue;
    }
    // Format 2: `@e5 [button] "Sign In"` or `@e5 button "Sign In"`
    m = line.match(/^@(e\d+)\s+\[?([a-zA-Z0-9_-]+)\]?(?:\s+"([^"]*)")?/);
    if (m) {
      refMap.set(`@${m[1]}`, { role: m[2].toLowerCase(), name: m[3] || '', rawLine: line });
    }
  }
  return refMap;
}

export function computeSnapshotDelta(prevText = '', nextText = '') {
  const prevLines = new Set(
    String(prevText)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  );
  const nextLinesArr = String(nextText)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const nextSet = new Set(nextLinesArr);
  const added = nextLinesArr.filter((l) => !prevLines.has(l));
  const removedCount = [...prevLines].filter((l) => !nextSet.has(l)).length;
  return {
    totalInteractive: nextLinesArr.length,
    addedCount: added.length,
    removedCount,
    deltaLines: added.slice(0, 40),
  };
}

export function resolveSemanticLocator(refOrSelector, refMap) {
  if (typeof refOrSelector === 'string' && refOrSelector.startsWith('@e')) {
    const meta = refMap?.get(refOrSelector);
    if (meta) {
      if (meta.role && meta.name) {
        return { strategy: 'getByRole', role: meta.role, value: meta.name };
      }
      if (meta.name) {
        return { strategy: 'getByLabel', value: meta.name };
      }
      if (meta.role) {
        return { strategy: 'getByRole', role: meta.role, value: meta.role };
      }
    }
  }
  const sel = String(refOrSelector || '');
  const testIdMatch = sel.match(/\[data-test(?:id)?=["']([^"']+)["']\]/);
  if (testIdMatch) {
    return { strategy: 'getByTestId', value: testIdMatch[1] };
  }
  return { strategy: 'getByText', value: sel || 'unknown' };
}

export function isSensitiveInput(fieldMeta = {}, value = '') {
  const fieldName = `${fieldMeta.name || ''} ${fieldMeta.role || ''} ${fieldMeta.rawLine || ''}`;
  if (SENSITIVE_FIELD_RE.test(fieldName)) return true;
  if (typeof value === 'string' && SENSITIVE_VALUE_RE.test(value.trim())) return true;
  return false;
}

export function redactInputToBuilderRef(fieldMeta = {}, value = '', scenarioId = 'explore') {
  const pascal = String(scenarioId)
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join('');
  const builderClass = `${pascal || 'Explore'}DataBuilder`;
  const rawName = String(fieldMeta.name || 'field')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  let prop = 'inputValue';
  if (/pass(word|code)?/.test(rawName)) prop = 'password';
  else if (/email/.test(rawName)) prop = 'email';
  else if (/user(name)?|login/.test(rawName)) prop = 'username';
  else if (/token|secret|key/.test(rawName)) prop = 'apiToken';
  else if (/ssn|social/.test(rawName)) prop = 'taxId';
  else if (/card|cvv|cvc/.test(rawName)) prop = 'paymentToken';
  else if (/phone|mobile/.test(rawName)) prop = 'phoneNumber';
  else if (rawName) {
    const parts = rawName.split(' ').filter(Boolean);
    prop = parts[0] + parts.slice(1).map((p) => p[0].toUpperCase() + p.slice(1)).join('');
  }
  const redacted = isSensitiveInput(fieldMeta, value);
  return {
    dataBuilderRef: `${builderClass}.standard().${prop}`,
    redacted,
  };
}

export function interpolateVariables(template, variables = {}) {
  if (typeof template !== 'string') return '';
  return template.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_, key) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? String(variables[key]) : `{{${key}}}`
  );
}

export function parseNetworkContracts(networkOutput = '', existing = []) {
  const seen = new Set(existing.map((c) => `${c.method} ${c.urlPattern}`));
  const added = [];
  for (const line of String(networkOutput).split('\n')) {
    const m = line.match(/\b(GET|POST|PUT|PATCH|DELETE)\s+(https?:\/\/[^\s]+|\/api\/[^\s]+|\/[^\s]+)/i);
    if (!m) continue;
    const method = m[1].toUpperCase();
    let urlPath = m[2];
    try {
      if (/^https?:\/\//i.test(urlPath)) {
        urlPath = new URL(urlPath).pathname;
      }
    } catch {
      /* keep raw */
    }
    // Skip static assets
    if (/\.(js|css|png|jpg|jpeg|svg|ico|woff2?|map)(\?|$)/i.test(urlPath)) continue;
    const statusMatch = line.match(/\b([2-5]\d{2})\b/);
    const expectedStatus = statusMatch ? Number(statusMatch[1]) : 200;
    const key = `${method} ${urlPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    added.push({
      method,
      urlPattern: urlPath,
      expectedStatus,
    });
  }
  return added;
}

export function createDraftTape({
  scenarioId = 'explore-draft',
  title = 'Exploratory Session Draft',
  baseUrl = process.env.BASE_URL || 'http://localhost:3000',
  actor = 'primary',
  resumesFrom = null,
} = {}) {
  const safeId = validateSafeId(scenarioId, 'scenarioId');
  return {
    schemaVersion: '1.0.0',
    scenarioId: safeId,
    title,
    charter: 'happy-path-baseline',
    baseUrl,
    recordedAt: new Date().toISOString(),
    tags: ['@regression'],
    persona: {
      role: actor,
      dataBuilderRef: `${safeId.split('-').map((p) => p[0].toUpperCase() + p.slice(1)).join('')}DataBuilder.standard()`,
    },
    actors: [{ actorId: actor, role: actor, portalBaseUrl: baseUrl }],
    preconditions: ['Seeded prerequisite state ready via cortex explore'],
    ...(resumesFrom ? { resumesFrom } : {}),
    capturedVariables: [],
    semanticSteps: [],
    networkContracts: [],
    expectedStates: [],
  };
}

export function appendRecordedAction(
  draftTape,
  { action, refOrSelector, value, refMap, pageRoute, businessStep, actor, domainGraph }
) {
  const allowedActions = new Set(['goto', 'fill', 'click', 'select', 'check', 'uncheck', 'press', 'hover', 'wait']);
  const normalizedAction = action === 'type' ? 'fill' : action;
  if (!allowedActions.has(normalizedAction)) return null;

  const stepIndex = draftTape.semanticSteps.length + 1;
  const fieldMeta = typeof refOrSelector === 'string' ? refMap?.get(refOrSelector) : undefined;
  const locatorContract =
    normalizedAction === 'goto'
      ? { strategy: 'url', value: String(refOrSelector || '/') }
      : resolveSemanticLocator(refOrSelector, refMap);

  let dataBuilderRef;
  let redacted = false;
  if (normalizedAction === 'fill' || normalizedAction === 'select') {
    const res = redactInputToBuilderRef(fieldMeta, value, draftTape.scenarioId);
    dataBuilderRef = res.dataBuilderRef;
    redacted = res.redacted;
  }

  const stepLabel = businessStep || `Complete ${pageRoute || 'current'} workflow interaction`;
  const existingComp = resolveComponentFromDomainGraph(pageRoute || '/', domainGraph);
  const stepObj = {
    stepIndex,
    intent: `${normalizedAction} ${locatorContract.value || pageRoute || 'control'}`,
    businessStep: stepLabel,
    pageRoute: pageRoute || '/',
    componentCandidate:
      existingComp ||
      `${String(pageRoute || 'main')
        .replace(/^\/+|\/+$/g, '')
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .slice(-1)
        .map((p) => p[0].toUpperCase() + p.slice(1))
        .join('') || 'Main'}SectionComponent`,
    action: normalizedAction,
    locatorContract,
    ...(dataBuilderRef ? { dataBuilderRef } : {}),
    ...(actor ? { actor } : {}),
  };

  draftTape.semanticSteps.push(stepObj);
  return { stepObj, redacted };
}

export function switchDraftActor(draftTape, { actorId, role, portalBaseUrl, storageStatePath }) {
  const safeActor = validateSafeId(actorId, 'actorId');
  if (!Array.isArray(draftTape.actors)) draftTape.actors = [];
  if (!draftTape.actors.some((a) => a.actorId === safeActor)) {
    draftTape.actors.push({
      actorId: safeActor,
      role: role || safeActor,
      ...(portalBaseUrl ? { portalBaseUrl } : {}),
      ...(storageStatePath ? { storageStatePath } : {}),
    });
  }
  return safeActor;
}

export function finalizeDraftTape(draftTape, scenarioId) {
  const safeId = validateSafeId(scenarioId || draftTape.scenarioId, 'scenarioId');
  const finalized = {
    ...draftTape,
    scenarioId: safeId,
    recordedAt: new Date().toISOString(),
    networkContracts: Array.isArray(draftTape.networkContracts) ? draftTape.networkContracts : [],
  };
  if (finalized.semanticSteps.length === 0) {
    finalized.semanticSteps.push({
      stepIndex: 1,
      intent: 'Navigate to target application route',
      businessStep: 'Navigate to target application route',
      pageRoute: '/',
      componentCandidate: 'MainSectionComponent',
      action: 'goto',
      locatorContract: { strategy: 'url', value: '/' },
    });
  }
  if (finalized.expectedStates.length === 0) {
    const lastStep = finalized.semanticSteps[finalized.semanticSteps.length - 1];
    finalized.expectedStates.push({
      description: `Verify ${lastStep.componentCandidate} is visible`,
      businessStep: lastStep.businessStep || 'Verify workflow outcome',
      targetComponent: lastStep.componentCandidate,
      targetProperty: 'root',
      assertionType: 'toBeVisible',
      expectedValueRef: 'true',
      ...(lastStep.actor ? { actor: lastStep.actor } : {}),
    });
  }
  if (Array.isArray(finalized.capturedVariables) && finalized.capturedVariables.length === 0) {
    delete finalized.capturedVariables;
  }
  if (Array.isArray(finalized.actors) && finalized.actors.length <= 1) {
    delete finalized.actors;
  }
  return finalized;
}

// ─── Phase 2: Speed, Token Compression, Domain Reuse & Seeder Promotion ─────

export function resolveLocalBin(binName, rootDir = ROOT) {
  const ext = process.platform === 'win32' ? '.cmd' : '';
  const localPath = path.join(rootDir, 'node_modules', '.bin', `${binName}${ext}`);
  if (fs.existsSync(localPath)) {
    return { command: localPath, prefixArgs: [] };
  }
  return { command: 'npx', prefixArgs: ['--no-install', binName] };
}

export function pruneSnapshotLines(
  lines = [],
  { prevChromeLines = new Set(), scope = '', maxRepeatedRows = 2, maxLines = 30 } = {}
) {
  const rawArr = Array.isArray(lines)
    ? lines.map((l) => String(l).trim()).filter(Boolean)
    : String(lines || '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

  // 1. Optional landmark scope filter (e.g. --scope main | dialog | form)
  let scoped = rawArr;
  if (scope) {
    const scopeRe = new RegExp(`\\b${scope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const idx = rawArr.findIndex((l) => scopeRe.test(l));
    if (idx !== -1) {
      scoped = rawArr.slice(idx);
    }
  }

  // 2. Drop persistent boilerplate chrome lines seen across previous routes
  const withoutChrome = prevChromeLines.size > 0 ? scoped.filter((l) => !prevChromeLines.has(l)) : scoped;

  // 3. Collapse consecutive repeated sibling rows/items/options (e.g. 50-row tables)
  const collapsed = [];
  let prevRoleKey = '';
  let repeatCount = 0;
  let suppressedCount = 0;
  const flushSuppressed = () => {
    if (suppressedCount > 0) {
      collapsed.push(`... (+${suppressedCount} similar ${prevRoleKey || 'item'} entries)`);
      suppressedCount = 0;
    }
  };

  for (const line of withoutChrome) {
    const m = line.match(/^(?:-\s+|@e\d+\s+\[?)([a-zA-Z0-9_-]+)/);
    const roleKey = m ? m[1].toLowerCase() : '';
    const isRepeatable = ['listitem', 'row', 'option', 'gridcell', 'cell', 'link', 'treeitem'].includes(roleKey);
    if (isRepeatable && roleKey === prevRoleKey) {
      repeatCount++;
      if (repeatCount > maxRepeatedRows) {
        suppressedCount++;
        continue;
      }
    } else {
      flushSuppressed();
      prevRoleKey = roleKey;
      repeatCount = 1;
    }
    collapsed.push(line);
  }
  flushSuppressed();

  const truncated = collapsed.length > maxLines;
  const finalLines = truncated ? [...collapsed.slice(0, maxLines), `... (+${collapsed.length - maxLines} more)`] : collapsed;
  return {
    lines: finalLines,
    originalCount: rawArr.length,
    prunedCount: rawArr.length - finalLines.length,
  };
}

export function formatCompactOutput(payload = {}) {
  const parts = [];
  if (payload.status) parts.push(`STATUS: ${payload.status}`);
  if (payload.url) parts.push(`URL: ${payload.url}`);
  if (payload.actor) parts.push(`ACTOR: ${payload.actor}`);
  if (payload.cdpPort) parts.push(`CDP: ${payload.cdpPort}`);
  if (typeof payload.recordedSteps === 'number') parts.push(`STEPS: +${payload.recordedSteps}`);
  if (payload.redactedInputs) parts.push(`REDACTED: ${payload.redactedInputs}`);
  if (payload.snapshotDelta) {
    parts.push(`REFS: +${payload.snapshotDelta.addedCount}/${payload.snapshotDelta.totalInteractive}`);
  } else if (typeof payload.interactiveRefs === 'number') {
    parts.push(`REFS: ${payload.interactiveRefs}`);
  }

  const out = [parts.join(' | ')];
  const refLines = payload.snapshotDelta?.deltaLines || payload.snapshot || [];
  if (refLines.length > 0) {
    const terseRefs = refLines.map((l) => {
      const m = l.match(/^-\s+([a-zA-Z0-9_-]+)(?:\s+"([^"]*)")?.*?\[ref=(e\d+)\]/);
      if (m) return `@${m[3]}[${m[1]}${m[2] ? ` "${m[2]}"` : ''}]`;
      return l;
    });
    out.push(terseRefs.join(' | '));
  }
  if (Array.isArray(payload.assertions) && payload.assertions.length > 0) {
    out.push(
      `ASSERT: ${payload.assertions.map((a) => `${a.assertionType}(${a.target})=${a.passed ? 'OK' : 'WARN'}`).join(', ')}`
    );
  }
  if (Array.isArray(payload.newNetworkContracts) && payload.newNetworkContracts.length > 0) {
    out.push(
      `API: ${payload.newNetworkContracts.map((c) => `${c.method} ${c.urlPattern} (${c.expectedStatus})`).join(', ')}`
    );
  }
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    out.push(`ERR(${payload.errors.length}): ${payload.errors.slice(0, 3).join(' ; ')}`);
  }
  if (payload.tape) {
    out.push(`TAPE: ${payload.tape}${payload.compiled ? ' [compiled]' : ''}${payload.verified ? ' [verified]' : ''}`);
  }
  if (payload.seederFile) {
    out.push(`SEEDER: ${payload.seederFile}`);
  }
  if (payload.seederTip) {
    out.push(`TIP: ${payload.seederTip}`);
  }
  return out.join('\n');
}

export function resolveComponentFromDomainGraph(pageRoute = '/', domainGraph = null) {
  if (!domainGraph || !Array.isArray(domainGraph.shards)) return null;
  const normRoute = String(pageRoute || '/').replace(/\/+$/, '') || '/';
  for (const shard of domainGraph.shards) {
    const routes = Array.isArray(shard.routes) ? shard.routes : [];
    const matches = routes.some((r) => {
      const nr = String(r).replace(/\/+$/, '') || '/';
      return nr === normRoute || (nr !== '/' && normRoute.startsWith(nr));
    });
    if (matches && Array.isArray(shard.publishedCapabilities)) {
      const comp = shard.publishedCapabilities.find((c) => /Component$/.test(c));
      if (comp) return comp;
    }
  }
  return null;
}

export function appendRecordedAssertion(
  draftTape,
  { refOrSelector, assertionType = 'toBeVisible', expectedValue = 'true', refMap, pageRoute, businessStep, actor, domainGraph }
) {
  const allowedAssertions = new Set(['toBeVisible', 'toContainText', 'toHaveText', 'toHaveValue', 'toHaveURL', 'toBeEnabled', 'toBeHidden']);
  const safeAssertion = allowedAssertions.has(assertionType) ? assertionType : 'toBeVisible';
  const loc = resolveSemanticLocator(refOrSelector, refMap);
  const compName =
    resolveComponentFromDomainGraph(pageRoute, domainGraph) ||
    draftTape.semanticSteps[draftTape.semanticSteps.length - 1]?.componentCandidate ||
    'MainSectionComponent';
  const rawProp = String(loc.value || 'root')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((p, idx) => (idx === 0 ? p : p[0].toUpperCase() + p.slice(1)))
    .join('');
  const targetProperty = rawProp || 'root';

  const expectedObj = {
    description: `Verify ${loc.value || targetProperty} satisfies ${safeAssertion}`,
    businessStep: businessStep || `Verify ${pageRoute || 'workflow'} state`,
    targetComponent: compName,
    targetProperty,
    assertionType: safeAssertion,
    expectedValueRef: String(expectedValue ?? 'true'),
    ...(actor ? { actor } : {}),
  };
  draftTape.expectedStates.push(expectedObj);
  return expectedObj;
}

export function detectMutatingApiContracts(networkContracts = []) {
  return (Array.isArray(networkContracts) ? networkContracts : []).filter((c) =>
    ['POST', 'PUT', 'PATCH'].includes(String(c?.method || '').toUpperCase())
  );
}

export function buildSeederCodeFromTape(tape, mutatingContracts = []) {
  const scenarioId = validateSafeId(tape?.scenarioId || 'seeded-state', 'scenarioId');
  const pascal = scenarioId
    .split('-')
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join('');
  const className = `${pascal}Seeder`;
  const primary = mutatingContracts[0] || { method: 'POST', urlPattern: '/api/v1/seed', expectedStatus: 201 };
  const method = String(primary.method || 'POST').toLowerCase();
  const varNames = (Array.isArray(tape?.capturedVariables) ? tape.capturedVariables : [])
    .map((v) => v?.name)
    .filter((n) => typeof n === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n));

  const extractLines =
    varNames.length > 0
      ? varNames.map((v) => `      ${v}: String(body[${JSON.stringify(v)}] ?? body.id ?? crypto.randomUUID()),`).join('\n')
      : '      id: String(body.id ?? crypto.randomUUID()),';

  return {
    className,
    relPath: `src/seeders/${scenarioId}.seeder.ts`,
    codeContent: `import crypto from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import type { StateSeederContract } from '@contracts/state-seeder.contract';

/**
 * Auto-Promoted API State Seeder (SRP <= 150 lines, zero expect(), LSP: StateSeederContract).
 * Promoted from mutating API contract observed during exploration of '${scenarioId}'.
 */
export class ${className} implements StateSeederContract<Record<string, unknown>, Record<string, string>> {
  constructor(
    private readonly request: APIRequestContext,
    private readonly baseUrl: string
  ) {}

  async seed(payload: Record<string, unknown> = {}): Promise<Record<string, string>> {
    const res = await this.request.${method}(\`\${this.baseUrl.replace(/\\/+$/, '')}${primary.urlPattern}\`, {
      data: payload,
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return {
${extractLines}
    };
  }

  async teardown(handle: Record<string, string>): Promise<void> {
    void handle;
  }
}
`,
  };
}

// ─── Private CLI I/O & Agent-Browser Process Helpers ────────────────────────

function writePrivateJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* non-POSIX */
  }
}

function readJsonOrNull(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function runAgentBrowser(session, args, { allowFail = false } = {}) {
  const { command, prefixArgs } = resolveLocalBin('agent-browser');
  const fullArgs = [...prefixArgs, '--session', session, ...args];
  const res = spawnSync(command, fullArgs, { cwd: ROOT, encoding: 'utf8' });
  if (res.status !== 0 && !allowFail) {
    throw new Error(`agent-browser failed (${args.join(' ')}): ${(res.stderr || res.stdout || '').trim()}`);
  }
  return (res.stdout || '').trim();
}

async function collectSinglePassCdpTelemetry(cdpPort) {
  if (!cdpPort) return null;
  try {
    const pw = await import('@playwright/test');
    const browser = await pw.chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    try {
      const ctx = browser.contexts()[0];
      const page = ctx?.pages()[0];
      if (!ctx || !page) return null;
      const url = page.url();
      const cookies = await ctx.cookies();
      let storage = { localStorage: {}, sessionStorage: {} };
      try {
        storage = await page.evaluate(() => {
          const read = (s) => {
            const o = {};
            for (let i = 0; i < s.length; i++) {
              const k = s.key(i);
              if (k !== null) o[k] = s.getItem(k) ?? '';
            }
            return o;
          };
          return { localStorage: read(window.localStorage), sessionStorage: read(window.sessionStorage) };
        });
      } catch {
        /* cross-origin or blank */
      }
      return { url, cookies, ...storage };
    } finally {
      await browser.close().catch(() => {});
    }
  } catch {
    return null;
  }
}

function emitOutput(payload, { json = false } = {}) {
  console.log(json ? JSON.stringify(payload, null, 2) : formatCompactOutput(payload));
}

async function waitForLiveHandshake(timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(LIVE_SESSION_FILE)) {
      try {
        const data = JSON.parse(fs.readFileSync(LIVE_SESSION_FILE, 'utf8'));
        if (data && data.cdpPort && data.readyAt) return data;
      } catch {
        /* still writing */
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for Point-A spec CDP handshake (${LIVE_SESSION_FILE}).`);
}

function getFlagValue(args, flag, fallback = undefined) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return fallback;
  return args[idx + 1];
}

function printHelp() {
  console.log(`Usage: cortex explore <subcommand> [options]

Subcommands:
  start       Reach Point A and attach agent-browser (headless by default; compact DSL output, --json opt-in):
                --from-spec <tests/foo.spec.ts> [--grep "<title>"] [--until-step "<step>"] [--headed]
                --from-seed <src/...|scripts/...> --url <url> [--auth <.auth/p.json>]
                --checkpoint <name> | --url <url> [--scope main] [--scenario <id>] [--actor <id>] [--json]
  act         Execute 1 action or inline assert, record to draft tape, return pruned -i delta:
                cortex explore act <click|fill|select|check|press|goto|assert> [args...] [--step "<business>"] [--scope main] [--json]
  batch       Execute JSON array of actions/assertions in 1 round-trip with pruned -i delta + errors:
                cortex explore batch '[["fill","@e2","val"],["click","@e5"],["assert","@e9","toBeVisible"]]' [--step "<business>"] [--scope main] [--json]
  actor       Switch portal/actor mid-session carrying capturedVariables:
                cortex explore actor <actorId> [--url <portal-url>] [--auth <.auth/p.json>] [--json]
  capture     Capture a runtime variable (e.g. quoteId) for cross-portal reuse:
                cortex explore capture <varName> --from <url|eval> --expr "<regex|js>"
  checkpoint  Save or list reusable <1s browser checkpoints (.exploratory/checkpoints/):
                cortex explore checkpoint save <name> | list
  finish      Finalize & validate Session Tape, release browser, optionally compile, verify single spec, or promote API seeder:
                cortex explore finish [--scenario <id>] [--compile] [--verify] [--emit-seeder] [--keep-browser] [--json]
  status      Show active exploration session, actor, capturedVariables, and recorded step count [--json]
`);
}

// ─── CLI Command Implementations ────────────────────────────────────────────

async function cmdStart(args) {
  const session = validateSafeId(getFlagValue(args, '--session', 'explore'), 'session');
  const scenarioId = validateSafeId(getFlagValue(args, '--scenario', 'explore-draft'), 'scenario');
  const actorId = validateSafeId(getFlagValue(args, '--actor', 'primary'), 'actor');
  const fromSpec = getFlagValue(args, '--from-spec');
  const grepTitle = getFlagValue(args, '--grep');
  const untilStep = getFlagValue(args, '--until-step');
  const fromSeed = getFlagValue(args, '--from-seed');
  const checkpointName = getFlagValue(args, '--checkpoint');
  const rawUrl = getFlagValue(args, '--url', process.env.BASE_URL || '');
  const authPath = getFlagValue(args, '--auth');
  const scope = getFlagValue(args, '--scope', '');
  const headed = args.includes('--headed');
  const jsonOut = args.includes('--json');

  let cdpPort = null;
  let currentUrl = rawUrl;
  let variables = {};
  let resumesFrom = null;
  let checkpointPath = null;
  let specPid = null;

  if (fromSpec) {
    const safeSpec = resolveConfinedPath(ROOT, fromSpec, 'tests/', '--from-spec');
    cdpPort = await findFreePort();
    if (fs.existsSync(LIVE_SESSION_FILE)) fs.unlinkSync(LIVE_SESSION_FILE);
    if (fs.existsSync(RELEASE_SENTINEL_FILE)) fs.unlinkSync(RELEASE_SENTINEL_FILE);

    const pwBin = resolveLocalBin('playwright');
    const pwArgs = [...pwBin.prefixArgs, 'test', safeSpec.relPath, '--project=chromium', '--timeout=0'];
    if (headed) pwArgs.push('--headed');
    if (grepTitle) pwArgs.push('-g', grepTitle);

    const child = spawn(pwBin.command, pwArgs, {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        PW_PAUSE_FOR_EXPLORE: '1',
        PW_EXPLORE_HANDSHAKE: '1',
        EXPLORE_CDP_PORT: String(cdpPort),
        PW_EXPLORE_CHECKPOINT: scenarioId,
        ...(untilStep ? { PW_EXPLORE_UNTIL_STEP: untilStep } : {}),
      },
    });
    child.unref();
    specPid = child.pid;

    const handshake = await waitForLiveHandshake();
    cdpPort = handshake.cdpPort;
    currentUrl = handshake.currentUrl || currentUrl;
    variables = handshake.variables || {};
    checkpointPath = handshake.checkpointPath || null;
    runAgentBrowser(session, ['--cdp', String(cdpPort), 'eval', 'location.href']);

    const parentScenario = path.basename(safeSpec.relPath, '.spec.ts').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
    resumesFrom = {
      scenarioId: parentScenario === scenarioId ? `${parentScenario}-prereq` : parentScenario,
      specFile: safeSpec.relPath,
      handoffStrategy: 'ui-prereq',
      ...(handshake.pausedAtStep ? { resumeStep: handshake.pausedAtStep } : {}),
    };
  } else if (checkpointName) {
    const safeCk = validateSafeId(checkpointName, 'checkpoint');
    const ckFile = path.join(CHECKPOINTS_DIR, `${safeCk}.json`);
    if (!fs.existsSync(ckFile)) {
      throw new Error(`Checkpoint not found: .exploratory/checkpoints/${safeCk}.json`);
    }
    const ck = JSON.parse(fs.readFileSync(ckFile, 'utf8'));
    currentUrl = rawUrl || ck.url || process.env.BASE_URL || 'about:blank';
    variables = ck.variables || {};
    checkpointPath = `.exploratory/checkpoints/${safeCk}.json`;
    const openArgs = headed ? ['--headed', 'open', currentUrl] : ['open', currentUrl];
    runAgentBrowser(session, openArgs);
    // Hydrate localStorage & sessionStorage via eval
    const hydrateJs = `(() => {
      const l = ${JSON.stringify(ck.localStorage || {})};
      const s = ${JSON.stringify(ck.sessionStorage || {})};
      for (const [k,v] of Object.entries(l)) localStorage.setItem(k, v);
      for (const [k,v] of Object.entries(s)) sessionStorage.setItem(k, v);
      return location.href;
    })()`;
    runAgentBrowser(session, ['eval', hydrateJs], { allowFail: true });
    if (ck.url) runAgentBrowser(session, ['open', ck.url], { allowFail: true });
    resumesFrom = {
      scenarioId: safeCk === scenarioId ? `${safeCk}-prereq` : safeCk,
      handoffStrategy: 'checkpoint-state',
      checkpointPath,
    };
  } else if (fromSeed) {
    const allowed = fromSeed.startsWith('src/') ? 'src/' : 'scripts/';
    const safeSeed = resolveConfinedPath(ROOT, fromSeed, allowed, '--from-seed');
    const seedRes = spawnSync(process.execPath, [safeSeed.absPath], { cwd: ROOT, encoding: 'utf8' });
    if (seedRes.status !== 0) {
      throw new Error(`Seeder script failed (${safeSeed.relPath}): ${(seedRes.stderr || seedRes.stdout || '').trim()}`);
    }
    try {
      const parsed = JSON.parse((seedRes.stdout || '{}').trim());
      if (parsed && typeof parsed === 'object') variables = parsed;
    } catch {
      /* non-JSON seeder stdout */
    }
    currentUrl = interpolateVariables(rawUrl || process.env.BASE_URL || 'http://localhost:3000', variables);
    const openArgs = headed ? ['--headed', 'open', currentUrl] : ['open', currentUrl];
    runAgentBrowser(session, openArgs);
    resumesFrom = {
      scenarioId: `${scenarioId}-seed`,
      handoffStrategy: 'api-seed',
    };
  } else {
    if (!currentUrl) {
      throw new Error('Provide --from-spec, --from-seed, --checkpoint, or --url <url>.');
    }
    const openArgs = headed ? ['--headed', 'open', currentUrl] : ['open', currentUrl];
    runAgentBrowser(session, openArgs);
  }

  if (authPath) {
    resolveConfinedPath(ROOT, authPath, '.auth/', '--auth');
  }

  const snap = runAgentBrowser(session, ['snapshot', '-i'], { allowFail: true });
  const liveUrl = runAgentBrowser(session, ['eval', 'location.href'], { allowFail: true }) || currentUrl;
  const draftTape = createDraftTape({
    scenarioId,
    title: scenarioId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    baseUrl: liveUrl.replace(/^"|"$/g, ''),
    actor: actorId,
    resumesFrom,
  });

  writePrivateJson(LIVE_DRAFT_TAPE_FILE, draftTape);
  writePrivateJson(LIVE_STATE_FILE, {
    session,
    activeSession: session,
    scenarioId,
    actor: actorId,
    cdpPort,
    specPid,
    checkpointPath,
    url: liveUrl.replace(/^"|"$/g, ''),
    variables,
    lastSnapshot: snap,
    startedAt: new Date().toISOString(),
  });

  const prunedStart = pruneSnapshotLines(snap, { scope });
  emitOutput(
    {
      status: 'ready',
      session,
      scenarioId,
      actor: actorId,
      cdpPort,
      url: liveUrl.replace(/^"|"$/g, ''),
      checkpointPath,
      variables,
      interactiveRefs: parseSnapshotRefs(snap).size,
      snapshot: prunedStart.lines,
    },
    { json: jsonOut }
  );
}

async function executeActions(actionTuples, { stepTitle, scope = '', json = false }) {
  const state = readJsonOrNull(LIVE_STATE_FILE);
  const draftTape = readJsonOrNull(LIVE_DRAFT_TAPE_FILE);
  if (!state || !draftTape) {
    throw new Error('No active explore session. Run `cortex explore start ...` first.');
  }
  const domainGraph = readJsonOrNull(path.join(ROOT, '.agents', 'domain', 'domain-graph.json'));
  const session = state.activeSession || state.session;
  const refMap = parseSnapshotRefs(state.lastSnapshot || '');
  const recorded = [];
  const recordedAssertions = [];

  for (const tuple of actionTuples) {
    const [action, target, rawVal, extraVal] = tuple;
    let pageRoute = '/';
    try {
      pageRoute = new URL(state.url).pathname || '/';
    } catch {
      /* fallback */
    }

    if (action === 'assert') {
      const assertionType = rawVal || 'toBeVisible';
      const expectedValue = extraVal !== undefined ? interpolateVariables(String(extraVal), state.variables) : 'true';
      const expectedObj = appendRecordedAssertion(draftTape, {
        refOrSelector: target,
        assertionType,
        expectedValue,
        refMap,
        pageRoute,
        businessStep: stepTitle,
        actor: state.actor,
        domainGraph,
      });
      const targetExists = refMap.has(target) || String(state.lastSnapshot || '').includes(String(target || ''));
      recordedAssertions.push({
        target: expectedObj.targetProperty,
        assertionType: expectedObj.assertionType,
        passed: targetExists,
      });
      continue;
    }

    const interpolatedVal = rawVal !== undefined ? interpolateVariables(String(rawVal), state.variables) : undefined;
    const interpolatedTarget = target !== undefined ? interpolateVariables(String(target), state.variables) : undefined;

    const cliArgs = [action];
    if (interpolatedTarget !== undefined) cliArgs.push(interpolatedTarget);
    if (interpolatedVal !== undefined) cliArgs.push(interpolatedVal);
    runAgentBrowser(session, cliArgs);

    const rec = appendRecordedAction(draftTape, {
      action,
      refOrSelector: interpolatedTarget,
      value: interpolatedVal,
      refMap,
      pageRoute,
      businessStep: stepTitle,
      actor: state.actor,
      domainGraph,
    });
    if (rec) recorded.push(rec);
  }

  const nextSnap = runAgentBrowser(session, ['snapshot', '-i'], { allowFail: true });
  const cdpTelemetry = await collectSinglePassCdpTelemetry(state.cdpPort);
  const nextUrl =
    cdpTelemetry?.url ||
    (runAgentBrowser(session, ['eval', 'location.href'], { allowFail: true }) || state.url).replace(/^"|"$/g, '');
  const errorsOut = runAgentBrowser(session, ['errors'], { allowFail: true });
  const netOut = runAgentBrowser(session, ['network', 'requests'], { allowFail: true });

  const newContracts = parseNetworkContracts(netOut, draftTape.networkContracts || []);
  if (newContracts.length > 0) {
    draftTape.networkContracts.push(...newContracts);
  }
  const rawDelta = computeSnapshotDelta(state.lastSnapshot || '', nextSnap);
  const prevChrome = new Set(Array.isArray(state.chromeLines) ? state.chromeLines : []);
  const pruned = pruneSnapshotLines(rawDelta.deltaLines, { prevChromeLines: prevChrome, scope });
  const delta = { ...rawDelta, deltaLines: pruned.lines, prunedCount: pruned.prunedCount };

  // Track persistent chrome lines that appear identically across route transitions
  if (nextUrl !== state.url && state.lastSnapshot) {
    const prevSet = new Set(String(state.lastSnapshot).split('\n').map((l) => l.trim()).filter(Boolean));
    const persistent = String(nextSnap)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && prevSet.has(l));
    state.chromeLines = [...new Set([...prevChrome, ...persistent])].slice(0, 80);
  }

  state.lastSnapshot = nextSnap;
  state.url = nextUrl;
  writePrivateJson(LIVE_STATE_FILE, state);
  writePrivateJson(LIVE_DRAFT_TAPE_FILE, draftTape);

  emitOutput(
    {
      url: nextUrl,
      actor: state.actor,
      recordedSteps: recorded.length,
      redactedInputs: recorded.filter((r) => r.redacted).length,
      assertions: recordedAssertions,
      snapshotDelta: delta,
      newNetworkContracts: newContracts,
      errors: errorsOut ? errorsOut.split('\n').filter(Boolean) : [],
    },
    { json }
  );
}

async function cmdActor(args) {
  const actorId = validateSafeId(args[0], 'actorId');
  const urlFlag = getFlagValue(args, '--url');
  const authPath = getFlagValue(args, '--auth');
  const role = getFlagValue(args, '--role', actorId);
  const jsonOut = args.includes('--json');
  const state = readJsonOrNull(LIVE_STATE_FILE);
  const draftTape = readJsonOrNull(LIVE_DRAFT_TAPE_FILE);
  if (!state || !draftTape) {
    throw new Error('No active explore session. Run `cortex explore start ...` first.');
  }
  if (authPath) resolveConfinedPath(ROOT, authPath, '.auth/', '--auth');

  const actorSession = `${state.session}-${actorId}`;
  const targetUrl = urlFlag ? interpolateVariables(urlFlag, state.variables) : state.url;
  if (targetUrl) {
    runAgentBrowser(actorSession, ['open', targetUrl], { allowFail: true });
  }
  switchDraftActor(draftTape, {
    actorId,
    role,
    portalBaseUrl: targetUrl,
    storageStatePath: authPath,
  });

  const snap = runAgentBrowser(actorSession, ['snapshot', '-i'], { allowFail: true });
  state.actor = actorId;
  state.activeSession = actorSession;
  state.url = targetUrl;
  state.lastSnapshot = snap;
  writePrivateJson(LIVE_STATE_FILE, state);
  writePrivateJson(LIVE_DRAFT_TAPE_FILE, draftTape);

  emitOutput(
    { status: 'switched-actor', actor: actorId, activeSession: actorSession, url: targetUrl, variables: state.variables },
    { json: jsonOut }
  );
}

async function cmdCapture(args) {
  const varName = args[0];
  if (!varName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) {
    throw new Error(`Invalid variable name '${varName}'.`);
  }
  const from = getFlagValue(args, '--from', 'url');
  const expr = getFlagValue(args, '--expr', '');
  const state = readJsonOrNull(LIVE_STATE_FILE);
  const draftTape = readJsonOrNull(LIVE_DRAFT_TAPE_FILE);
  if (!state || !draftTape) throw new Error('No active explore session.');
  const session = state.activeSession || state.session;

  let value = '';
  if (from === 'url') {
    const url = (runAgentBrowser(session, ['eval', 'location.href'], { allowFail: true }) || state.url).replace(/^"|"$/g, '');
    const m = expr ? url.match(new RegExp(expr)) : null;
    value = m ? m[1] || m[0] : url;
  } else {
    value = runAgentBrowser(session, ['eval', expr], { allowFail: true }).replace(/^"|"$/g, '');
  }
  state.variables[varName] = value;
  draftTape.capturedVariables.push({
    name: varName,
    capturedAtStep: Math.max(1, draftTape.semanticSteps.length),
    source: from === 'url' ? 'urlParam' : 'textContent',
  });
  writePrivateJson(LIVE_STATE_FILE, state);
  writePrivateJson(LIVE_DRAFT_TAPE_FILE, draftTape);
  console.log(JSON.stringify({ captured: { [varName]: value }, variables: state.variables }, null, 2));
}

async function cmdCheckpoint(args) {
  const sub = args[0];
  if (sub === 'list') {
    const files = fs.existsSync(CHECKPOINTS_DIR)
      ? fs.readdirSync(CHECKPOINTS_DIR).filter((f) => f.endsWith('.json'))
      : [];
    console.log(JSON.stringify({ checkpoints: files.map((f) => f.replace(/\.json$/, '')) }, null, 2));
    return;
  }
  if (sub === 'save') {
    const name = validateSafeId(args[1], 'checkpoint name');
    const state = readJsonOrNull(LIVE_STATE_FILE);
    if (!state) throw new Error('No active explore session.');
    const session = state.activeSession || state.session;

    let parsed = (await collectSinglePassCdpTelemetry(state.cdpPort)) || null;
    if (!parsed) {
      const rawDump = runAgentBrowser(
        session,
        [
          'eval',
          'JSON.stringify({ url: location.href, localStorage: Object.fromEntries(Object.entries(localStorage)), sessionStorage: Object.fromEntries(Object.entries(sessionStorage)) })',
        ],
        { allowFail: true }
      );
      parsed = { url: state.url, cookies: [], localStorage: {}, sessionStorage: {} };
      try {
        const inner = JSON.parse(rawDump);
        const obj = typeof inner === 'string' ? JSON.parse(inner) : inner;
        parsed = { ...parsed, ...obj };
      } catch {
        /* fallback */
      }
    }
    const ckPath = path.join(CHECKPOINTS_DIR, `${name}.json`);
    writePrivateJson(ckPath, {
      schemaVersion: '1.0.0',
      capturedAt: new Date().toISOString(),
      url: parsed.url || state.url,
      cookies: Array.isArray(parsed.cookies) ? parsed.cookies : [],
      localStorage: parsed.localStorage || {},
      sessionStorage: parsed.sessionStorage || {},
      variables: state.variables || {},
      actor: state.actor,
      scenarioId: state.scenarioId,
    });
    console.log(JSON.stringify({ saved: `.exploratory/checkpoints/${name}.json`, cookies: (parsed.cookies || []).length }, null, 2));
    return;
  }
  throw new Error(`Unknown checkpoint subcommand '${sub}'. Use 'save <name>' or 'list'.`);
}

async function cmdFinish(args) {
  const state = readJsonOrNull(LIVE_STATE_FILE);
  const draftTape = readJsonOrNull(LIVE_DRAFT_TAPE_FILE);
  if (!draftTape) throw new Error('No active draft tape found.');
  const scenarioId = validateSafeId(getFlagValue(args, '--scenario', draftTape.scenarioId), 'scenario');
  const shouldCompile = args.includes('--compile');
  const shouldVerify = args.includes('--verify');
  const emitSeeder = args.includes('--emit-seeder');
  const keepBrowser = args.includes('--keep-browser');
  const jsonOut = args.includes('--json');

  const finalized = finalizeDraftTape(draftTape, scenarioId);
  fs.mkdirSync(TAPES_DIR, { recursive: true });
  const tapeFile = path.join(TAPES_DIR, `${scenarioId}.json`);
  fs.writeFileSync(tapeFile, JSON.stringify(finalized, null, 2) + '\n', 'utf8');

  if (!keepBrowser) {
    fs.mkdirSync(EXPLORATORY_DIR, { recursive: true });
    fs.writeFileSync(RELEASE_SENTINEL_FILE, new Date().toISOString() + '\n', 'utf8');
    if (state?.session) {
      runAgentBrowser(state.session, ['close'], { allowFail: true });
    }
  }

  let seederFile = null;
  const mutatingContracts = detectMutatingApiContracts(finalized.networkContracts);
  let seederTip = null;
  if (emitSeeder && mutatingContracts.length > 0) {
    const built = buildSeederCodeFromTape(finalized, mutatingContracts);
    const safeOut = resolveConfinedPath(ROOT, built.relPath, 'src/seeders/', 'seeder output');
    fs.mkdirSync(path.dirname(safeOut.absPath), { recursive: true });
    fs.writeFileSync(safeOut.absPath, built.codeContent, 'utf8');
    seederFile = safeOut.relPath;
  } else if (mutatingContracts.length > 0) {
    seederTip = `Detected ${mutatingContracts.length} mutating API call(s) (${mutatingContracts[0].method} ${mutatingContracts[0].urlPattern}); re-run with --emit-seeder to promote Point A to a <300ms StateSeederContract.`;
  }

  const valRes = spawnSync(process.execPath, [path.join(__dirname, 'validate-tapes.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (valRes.status !== 0) {
    process.exit(valRes.status ?? 1);
  }

  if (shouldCompile) {
    const compRes = spawnSync(
      process.execPath,
      [path.join(__dirname, 'compile-tape.mjs'), scenarioId, '--apply'],
      { cwd: ROOT, stdio: 'inherit' }
    );
    if (compRes.status !== 0) {
      process.exit(compRes.status ?? 1);
    }
  }

  let verified = false;
  if (shouldVerify) {
    const tscBin = resolveLocalBin('tsc');
    const tscRes = spawnSync(tscBin.command, [...tscBin.prefixArgs, '--noEmit'], { cwd: ROOT, stdio: 'inherit' });
    if (tscRes.status !== 0) process.exit(tscRes.status ?? 1);

    const auditRes = spawnSync(process.execPath, [path.join(__dirname, 'audit-solid.mjs')], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    if (auditRes.status !== 0) process.exit(auditRes.status ?? 1);

    const specRel = `tests/${scenarioId}.spec.ts`;
    if (fs.existsSync(path.join(ROOT, specRel))) {
      const pwBin = resolveLocalBin('playwright');
      const pwRes = spawnSync(
        pwBin.command,
        [...pwBin.prefixArgs, 'test', specRel, '--project=chromium'],
        { cwd: ROOT, stdio: 'inherit' }
      );
      if (pwRes.status !== 0) process.exit(pwRes.status ?? 1);
    }
    verified = true;
  }

  emitOutput(
    {
      status: 'finished',
      tape: `.exploratory/tapes/${scenarioId}.json`,
      compiled: shouldCompile,
      verified,
      ...(seederFile ? { seederFile } : {}),
      ...(seederTip ? { seederTip } : {}),
    },
    { json: jsonOut }
  );
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }
  if (cmd === 'start') return cmdStart(args.slice(1));
  if (cmd === 'act') {
    const stepTitle = getFlagValue(args, '--step');
    const scope = getFlagValue(args, '--scope', '');
    const json = args.includes('--json');
    const clean = [];
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--step' || args[i] === '--scope') {
        i++;
        continue;
      }
      if (args[i] === '--json') continue;
      clean.push(args[i]);
    }
    return executeActions([clean], { stepTitle, scope, json });
  }
  if (cmd === 'batch') {
    const stepTitle = getFlagValue(args, '--step');
    const scope = getFlagValue(args, '--scope', '');
    const json = args.includes('--json');
    const tuples = JSON.parse(args[1] || '[]');
    if (!Array.isArray(tuples)) throw new Error('batch expects a JSON array of action tuples.');
    return executeActions(tuples, { stepTitle, scope, json });
  }
  if (cmd === 'actor') return cmdActor(args.slice(1));
  if (cmd === 'capture') return cmdCapture(args.slice(1));
  if (cmd === 'checkpoint') return cmdCheckpoint(args.slice(1));
  if (cmd === 'finish') return cmdFinish(args.slice(1));
  if (cmd === 'status') {
    const state = readJsonOrNull(LIVE_STATE_FILE);
    const draft = readJsonOrNull(LIVE_DRAFT_TAPE_FILE);
    const json = args.includes('--json');
    emitOutput(
      {
        status: state ? 'active' : 'idle',
        session: state?.session || null,
        actor: state?.actor || null,
        url: state?.url || null,
        cdpPort: state?.cdpPort || null,
        variables: state?.variables || {},
        recordedSteps: draft?.semanticSteps?.length || 0,
      },
      { json }
    );
    return;
  }
  throw new Error(`Unknown explore subcommand '${cmd}'. Run 'cortex explore --help'.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((err) => {
    console.error(`❌ cortex explore: ${err.message}`);
    process.exit(1);
  });
}
