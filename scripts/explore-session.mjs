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

export function appendRecordedAction(draftTape, { action, refOrSelector, value, refMap, pageRoute, businessStep, actor }) {
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
  const stepObj = {
    stepIndex,
    intent: `${normalizedAction} ${locatorContract.value || pageRoute || 'control'}`,
    businessStep: stepLabel,
    pageRoute: pageRoute || '/',
    componentCandidate: `${String(pageRoute || 'main')
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
  const fullArgs = ['--no-install', 'agent-browser', '--session', session, ...args];
  const res = spawnSync('npx', fullArgs, { cwd: ROOT, encoding: 'utf8' });
  if (res.status !== 0 && !allowFail) {
    throw new Error(`agent-browser failed (${args.join(' ')}): ${(res.stderr || res.stdout || '').trim()}`);
  }
  return (res.stdout || '').trim();
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
  start       Reach Point A and attach agent-browser (headless by default):
                --from-spec <tests/foo.spec.ts> [--grep "<title>"] [--until-step "<step>"] [--headed]
                --from-seed <src/...|scripts/...> --url <url> [--auth <.auth/p.json>]
                --checkpoint <name>
                --url <url> [--auth <.auth/p.json>]
                [--scenario <id>] [--actor <id>] [--session <name>]
  act         Execute a single action, auto-record into live draft tape, and return compact -i delta:
                cortex explore act <click|fill|select|check|press|goto> [args...] [--step "<business step>"]
  batch       Execute a JSON array of actions in 1 round-trip and return compact -i delta + errors:
                cortex explore batch '[["fill","@e2","val"],["click","@e5"]]' [--step "<business step>"]
  actor       Switch portal/actor mid-session carrying capturedVariables:
                cortex explore actor <actorId> [--url <portal-url>] [--auth <.auth/p.json>]
  capture     Capture a runtime variable (e.g. quoteId) for cross-portal reuse:
                cortex explore capture <varName> --from <url|eval> --expr "<regex|js>"
  checkpoint  Save or list reusable <1s browser checkpoints (.exploratory/checkpoints/):
                cortex explore checkpoint save <name> | list
  finish      Finalize & validate Session Tape, release held Point-A browser, optionally compile:
                cortex explore finish [--scenario <id>] [--compile] [--keep-browser]
  status      Show active exploration session, actor, capturedVariables, and recorded step count
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
  const headed = args.includes('--headed');

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

    const pwArgs = ['--no-install', 'playwright', 'test', safeSpec.relPath, '--project=chromium', '--timeout=0'];
    if (headed) pwArgs.push('--headed');
    if (grepTitle) pwArgs.push('-g', grepTitle);

    const child = spawn('npx', pwArgs, {
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

  console.log(
    JSON.stringify(
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
        snapshot: snap.split('\n').slice(0, 40),
      },
      null,
      2
    )
  );
}

async function executeActions(actionTuples, { stepTitle }) {
  const state = readJsonOrNull(LIVE_STATE_FILE);
  const draftTape = readJsonOrNull(LIVE_DRAFT_TAPE_FILE);
  if (!state || !draftTape) {
    throw new Error('No active explore session. Run `cortex explore start ...` first.');
  }
  const session = state.activeSession || state.session;
  let refMap = parseSnapshotRefs(state.lastSnapshot || '');
  const recorded = [];

  for (const tuple of actionTuples) {
    const [action, target, rawVal] = tuple;
    const interpolatedVal = rawVal !== undefined ? interpolateVariables(String(rawVal), state.variables) : undefined;
    const interpolatedTarget = target !== undefined ? interpolateVariables(String(target), state.variables) : undefined;

    const cliArgs = [action];
    if (interpolatedTarget !== undefined) cliArgs.push(interpolatedTarget);
    if (interpolatedVal !== undefined) cliArgs.push(interpolatedVal);
    runAgentBrowser(session, cliArgs);

    let pageRoute = '/';
    try {
      pageRoute = new URL(state.url).pathname || '/';
    } catch {
      /* fallback */
    }
    const rec = appendRecordedAction(draftTape, {
      action,
      refOrSelector: interpolatedTarget,
      value: interpolatedVal,
      refMap,
      pageRoute,
      businessStep: stepTitle,
      actor: state.actor,
    });
    if (rec) recorded.push(rec);
  }

  const nextSnap = runAgentBrowser(session, ['snapshot', '-i'], { allowFail: true });
  const nextUrl = (runAgentBrowser(session, ['eval', 'location.href'], { allowFail: true }) || state.url).replace(
    /^"|"$/g,
    ''
  );
  const errorsOut = runAgentBrowser(session, ['errors'], { allowFail: true });
  const netOut = runAgentBrowser(session, ['network', 'requests'], { allowFail: true });

  const newContracts = parseNetworkContracts(netOut, draftTape.networkContracts || []);
  if (newContracts.length > 0) {
    draftTape.networkContracts.push(...newContracts);
  }
  const delta = computeSnapshotDelta(state.lastSnapshot || '', nextSnap);

  state.lastSnapshot = nextSnap;
  state.url = nextUrl;
  writePrivateJson(LIVE_STATE_FILE, state);
  writePrivateJson(LIVE_DRAFT_TAPE_FILE, draftTape);

  console.log(
    JSON.stringify(
      {
        url: nextUrl,
        actor: state.actor,
        recordedSteps: recorded.length,
        redactedInputs: recorded.filter((r) => r.redacted).length,
        snapshotDelta: delta,
        newNetworkContracts: newContracts,
        errors: errorsOut ? errorsOut.split('\n').filter(Boolean) : [],
      },
      null,
      2
    )
  );
}

async function cmdActor(args) {
  const actorId = validateSafeId(args[0], 'actorId');
  const urlFlag = getFlagValue(args, '--url');
  const authPath = getFlagValue(args, '--auth');
  const role = getFlagValue(args, '--role', actorId);
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

  console.log(
    JSON.stringify(
      { status: 'switched-actor', actor: actorId, activeSession: actorSession, url: targetUrl, variables: state.variables },
      null,
      2
    )
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
    const rawDump = runAgentBrowser(
      session,
      [
        'eval',
        'JSON.stringify({ url: location.href, localStorage: Object.fromEntries(Object.entries(localStorage)), sessionStorage: Object.fromEntries(Object.entries(sessionStorage)) })',
      ],
      { allowFail: true }
    );
    let parsed = { url: state.url, localStorage: {}, sessionStorage: {} };
    try {
      const inner = JSON.parse(rawDump);
      parsed = typeof inner === 'string' ? JSON.parse(inner) : inner;
    } catch {
      /* fallback */
    }
    const ckPath = path.join(CHECKPOINTS_DIR, `${name}.json`);
    writePrivateJson(ckPath, {
      schemaVersion: '1.0.0',
      capturedAt: new Date().toISOString(),
      url: parsed.url || state.url,
      cookies: [],
      localStorage: parsed.localStorage || {},
      sessionStorage: parsed.sessionStorage || {},
      variables: state.variables || {},
      actor: state.actor,
      scenarioId: state.scenarioId,
    });
    console.log(JSON.stringify({ saved: `.exploratory/checkpoints/${name}.json` }, null, 2));
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
  const keepBrowser = args.includes('--keep-browser');

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

  console.log(
    JSON.stringify(
      {
        status: 'finished',
        tape: `.exploratory/tapes/${scenarioId}.json`,
        compiled: shouldCompile,
      },
      null,
      2
    )
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
    const clean = [];
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--step') {
        i++;
        continue;
      }
      clean.push(args[i]);
    }
    return executeActions([clean], { stepTitle });
  }
  if (cmd === 'batch') {
    const stepTitle = getFlagValue(args, '--step');
    const tuples = JSON.parse(args[1] || '[]');
    if (!Array.isArray(tuples)) throw new Error('batch expects a JSON array of action tuples.');
    return executeActions(tuples, { stepTitle });
  }
  if (cmd === 'actor') return cmdActor(args.slice(1));
  if (cmd === 'capture') return cmdCapture(args.slice(1));
  if (cmd === 'checkpoint') return cmdCheckpoint(args.slice(1));
  if (cmd === 'finish') return cmdFinish(args.slice(1));
  if (cmd === 'status') {
    const state = readJsonOrNull(LIVE_STATE_FILE);
    const draft = readJsonOrNull(LIVE_DRAFT_TAPE_FILE);
    console.log(
      JSON.stringify(
        {
          active: Boolean(state),
          session: state?.session || null,
          actor: state?.actor || null,
          url: state?.url || null,
          cdpPort: state?.cdpPort || null,
          variables: state?.variables || {},
          recordedSteps: draft?.semanticSteps?.length || 0,
        },
        null,
        2
      )
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
