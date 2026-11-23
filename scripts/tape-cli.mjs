#!/usr/bin/env node
/**
 * Cortex Session Tape CLI (`npx cortex tape`).
 *
 * Keeps `.exploratory/tapes/*.json` v1 schema 100% backward-compatible on disk while
 * eliminating raw JSON reading/authoring (~1.7k–4.5k tok) by AI agents.
 *
 * Subcommands:
 *   npx cortex tape list [--json]
 *   npx cortex tape show <scenarioId> [--json]
 *   npx cortex tape clone <srcId> <newId> [--title "..."] [--charter "..."] [--tags "@p1,@negative"]
 *                                         [--persona-role "..."] [--persona-builder "..."]
 *   npx cortex tape patch <scenarioId> [--set-title "..."] [--set-charter "..."]
 *                                      [--add-tag "@smoke"] [--remove-tag "@p0"]
 *                                      [--set-step <idx> <field=value>] [--remove-step <idx>]
 *                                      [--set-expect <idx> <field=value>] [--add-expect "<target>|<assertion>|<value>"]
 *                                      [--remove-expect <idx>] [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTapeObject } from './validate-tapes.mjs';
import { summarizeTapeCompact } from './context-pack.mjs';

const __filename = fileURLToPath(import.meta.url);
const SAFE_SCENARIO_ID_RE = /^[a-z0-9][a-z0-9-]{1,80}$/;

export function assertSafeScenarioId(id) {
  const clean = String(id || '').replace(/\.json$/i, '').trim();
  if (!SAFE_SCENARIO_ID_RE.test(clean)) {
    throw new Error(
      `Invalid scenarioId '${id}'. Must match ${SAFE_SCENARIO_ID_RE} (lowercase kebab-case, no path separators).`
    );
  }
  return clean;
}

function escapeRegExp(str) {
  return String(str ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertNoSymlinkEscape(rootDir, targetPath, label = 'path') {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Security Error: Path traversal detected for ${label}: '${targetPath}'.`);
  }
  let cur = resolvedTarget;
  while (cur !== resolvedRoot) {
    try {
      if (fs.lstatSync(cur).isSymbolicLink()) {
        throw new Error(
          `Security Error: Refusing symlinked path for ${label}: '${path.relative(resolvedRoot, cur)}'.`
        );
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  if (fs.existsSync(resolvedRoot)) {
    const realRoot = fs.realpathSync(resolvedRoot);
    let existing = resolvedTarget;
    while (!fs.existsSync(existing) && existing !== resolvedRoot) {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
    const realExisting = fs.realpathSync(existing);
    const realRel = path.relative(realRoot, realExisting);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw new Error(`Security Error: Realpath escapes workspace root for ${label}.`);
    }
  }
  return resolvedTarget;
}

function resolveTapePath(rootDir, scenarioId) {
  const safeId = assertSafeScenarioId(scenarioId);
  const tapesDir = path.resolve(rootDir, '.exploratory/tapes');
  const full = path.resolve(tapesDir, `${safeId}.json`);
  if (!full.startsWith(tapesDir + path.sep)) {
    throw new Error(`Refusing path outside .exploratory/tapes: ${full}`);
  }
  assertNoSymlinkEscape(rootDir, full, 'Session Tape');
  return { safeId, tapesDir, full };
}

function readTape(rootDir, scenarioId) {
  const { safeId, full } = resolveTapePath(rootDir, scenarioId);
  if (!fs.existsSync(full)) {
    throw new Error(`Session Tape not found: .exploratory/tapes/${safeId}.json`);
  }
  return { safeId, full, data: JSON.parse(fs.readFileSync(full, 'utf8')) };
}

function writeValidatedTape(rootDir, scenarioId, tapeObj, { dryRun = false } = {}) {
  const { safeId, tapesDir, full } = resolveTapePath(rootDir, scenarioId);
  const relFile = path.relative(rootDir, full).replace(/\\/g, '/');
  const errors = validateTapeObject(tapeObj, relFile, { expectedScenarioId: safeId });
  if (errors.length > 0) {
    throw new Error(`Tape validation failed (${errors.length}):\n- ${errors.slice(0, 6).join('\n- ')}`);
  }
  if (!dryRun) {
    assertNoSymlinkEscape(rootDir, full, 'Session Tape');
    fs.mkdirSync(tapesDir, { recursive: true });
    fs.writeFileSync(full, JSON.stringify(tapeObj, null, 2) + '\n', 'utf8');
  }
  return { safeId, relFile, written: !dryRun };
}

function walkFilesRecursive(dir, suffix, out = []) {
  if (!fs.existsSync(dir)) return out;
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) return out;
  } catch {
    return out;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFilesRecursive(full, suffix, out);
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      out.push(full);
    }
  }
  return out;
}

export function listTapes(rootDir = process.cwd()) {
  const tapesDir = path.join(rootDir, '.exploratory/tapes');
  if (!fs.existsSync(tapesDir) || fs.lstatSync(tapesDir).isSymbolicLink()) return [];
  const specsDir = path.join(rootDir, 'tests');
  const specSources = walkFilesRecursive(specsDir, '.spec.ts').map((full) => ({
    file: path.basename(full),
    content: fs.readFileSync(full, 'utf8'),
  }));

  return fs
    .readdirSync(tapesDir, { withFileTypes: true })
    .filter((e) => !e.isSymbolicLink() && e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name)
    .sort()
    .map((f) => {
      const data = JSON.parse(fs.readFileSync(path.join(tapesDir, f), 'utf8'));
      const id = data.scenarioId || path.basename(f, '.json');
      const idRe = new RegExp(`(?<![a-z0-9-])${escapeRegExp(id)}(?![a-z0-9-])`);
      const compiled = specSources.some(
        (s) => path.basename(s.file, '.spec.ts') === id || idRe.test(s.content)
      );
      return {
        scenarioId: id,
        title: data.title || '',
        charter: data.charter || '',
        steps: Array.isArray(data.semanticSteps) ? data.semanticSteps.length : 0,
        expects: Array.isArray(data.expectedStates) ? data.expectedStates.length : 0,
        tags: Array.isArray(data.tags) ? data.tags : [],
        compiled,
      };
    });
}

const NON_SMOKE_CHARTERS = new Set([
  'boundary-analysis',
  'negative-validation',
  'negative-auth',
  'state-interruption',
  'accessibility-audit',
  'chaos-fault',
  'security-probe',
]);

export function cloneTape(
  rootDir,
  srcId,
  newId,
  { title, charter, tags, personaRole, personaBuilder, setData = [], dryRun = false } = {}
) {
  const src = readTape(rootDir, srcId);
  const safeNewId = assertSafeScenarioId(newId);
  const { full: destFull } = resolveTapePath(rootDir, safeNewId);
  if (fs.existsSync(destFull)) {
    throw new Error(`Target tape already exists: .exploratory/tapes/${safeNewId}.json`);
  }
  const cloned = JSON.parse(JSON.stringify(src.data));
  cloned.scenarioId = safeNewId;
  cloned.recordedAt = new Date().toISOString();
  if (title) cloned.title = title;
  if (charter) cloned.charter = charter;
  if (tags && tags.length > 0) {
    cloned.tags = tags.map((t) => (t.startsWith('@') ? t : `@${t}`));
  } else if (charter && NON_SMOKE_CHARTERS.has(String(charter).trim().toLowerCase())) {
    const preservedDomainTags = (Array.isArray(cloned.tags) ? cloned.tags : []).filter(
      (t) => !/^@(?:p0|smoke|p1|regression)$/i.test(String(t))
    );
    cloned.tags = ['@p1', '@regression', ...preservedDomainTags];
  }
  if (personaRole || personaBuilder) {
    cloned.persona = { ...(cloned.persona || {}) };
    if (personaRole) cloned.persona.role = personaRole;
    if (personaBuilder) cloned.persona.dataBuilderRef = personaBuilder;
  }
  const res = writeValidatedTape(rootDir, safeNewId, cloned, { dryRun });
  const dataOverridesApplied =
    Array.isArray(setData) && setData.length > 0
      ? applyBuilderDataOverrides(rootDir, setData, { dryRun })
      : [];
  return { ...res, tape: cloned, dataOverridesApplied };
}

const ALLOWED_STEP_PATCH_FIELDS = new Set([
  'intent',
  'action',
  'inputDataRef',
  'componentCandidate',
  'waitForUrl',
  'waitForNetwork',
  'key',
  'businessStep',
  'pageRoute',
]);

const ALLOWED_EXPECT_PATCH_FIELDS = new Set([
  'targetComponent',
  'targetProperty',
  'assertionType',
  'expectedValueRef',
  'description',
]);

const FORBIDDEN_BUILDER_IDENTIFIERS = new Set([
  '__proto__',
  'prototype',
  'constructor',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'eval',
  'arguments',
  'default',
  'class',
  'function',
  'return',
  'import',
  'export',
]);

export function applyBuilderDataOverrides(rootDir, setData = [], { dryRun = false } = {}) {
  if (!Array.isArray(setData) || setData.length === 0) return [];
  const dataDir = path.join(rootDir, 'src/data');
  assertNoSymlinkEscape(rootDir, dataDir, 'src/data directory');
  const domainsDir = path.join(rootDir, 'src/domains');
  const builderFiles = [
    ...walkFilesRecursive(dataDir, '.builder.ts'),
    ...walkFilesRecursive(domainsDir, '.builder.ts'),
  ];
  const pendingWrites = new Map(); // targetFile -> content
  const applied = [];

  for (const item of setData) {
    const m = String(item.ref || '').match(/^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)(?:\(\))?\.([A-Za-z_][A-Za-z0-9_]*)$/);
    if (!m) {
      throw new Error(`Invalid --set-data reference '${item.ref}'. Expected 'BuilderClass.method().property=value'.`);
    }
    const [, builderClass, methodName, propName] = m;
    for (const ident of [builderClass, methodName, propName]) {
      if (FORBIDDEN_BUILDER_IDENTIFIERS.has(ident)) {
        throw new Error(`Security Error: Disallowed identifier '${ident}' in --set-data reference '${item.ref}'.`);
      }
    }
    if (/(?:password|passcode|secret|token|api[_-]?key|ssn|cvv|\bpin\b|_pin|pin_|\botp\b|_otp|otp_)/i.test(propName)) {
      throw new Error(`Security Error: Refusing to write sensitive property '${propName}' via --set-data. Use environment variables.`);
    }
    const serializedVal = JSON.stringify(String(item.value ?? ''));
    const classDeclRe = new RegExp(`\\bclass\\s+${escapeRegExp(builderClass)}\\b`);
    const readCurrent = (f) => (pendingWrites.has(f) ? pendingWrites.get(f) : fs.readFileSync(f, 'utf8'));
    let targetFile =
      [...pendingWrites.keys()].find((f) => classDeclRe.test(pendingWrites.get(f))) ||
      builderFiles.find((f) => classDeclRe.test(readCurrent(f)));
    if (!targetFile) {
      const kebab =
        builderClass
          .replace(/Builder$/, '')
          .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
          .toLowerCase() || builderClass.toLowerCase();
      targetFile = assertNoSymlinkEscape(rootDir, path.join(dataDir, `${kebab}.builder.ts`), 'Data Builder file');
      const newContent = `/**\n * Typed Data Builder (DIP).\n */\nexport class ${builderClass} {\n  static ${methodName}() {\n    return {\n      ${propName}: ${serializedVal},\n    };\n  }\n}\n`;
      pendingWrites.set(targetFile, newContent);
      applied.push({ builderClass, methodName, propName, file: path.relative(rootDir, targetFile) });
      continue;
    }

    assertNoSymlinkEscape(rootDir, targetFile, 'Data Builder file');
    let content = readCurrent(targetFile);
    const safeMethodRe = escapeRegExp(methodName);
    const safePropRe = escapeRegExp(propName);
    const methodHeadRe = new RegExp(
      `static\\s+${safeMethodRe}\\s*\\([^)]*\\)(?:\\s*:\\s*(?:\\{[^}]*\\}|[^{]+))?\\s*\\{\\s*return\\s*\\{`
    );
    const headMatch = content.match(methodHeadRe);
    if (headMatch) {
      const openBraceIdx = headMatch.index + headMatch[0].length - 1;
      let depth = 0;
      let quote = null;
      let closeBraceIdx = -1;
      for (let i = openBraceIdx; i < content.length; i++) {
        const ch = content[i];
        if (quote) {
          if (ch === '\\') {
            i++;
            continue;
          }
          if (ch === quote) quote = null;
          continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
          quote = ch;
          continue;
        }
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            closeBraceIdx = i;
            break;
          }
        }
      }
      if (closeBraceIdx < 0) {
        throw new Error(`Malformed return object in '${builderClass}.${methodName}()'.`);
      }
      const bodyStr = content.slice(openBraceIdx + 1, closeBraceIdx);
      const propRe = new RegExp(
        `(\\b${safePropRe}\\s*:\\s*)(?:'(?:\\\\.|[^'\\\\])*'|"(?:\\\\.|[^"\\\\])*"|-?\\d+(?:\\.\\d+)?|true|false|null|[^,\\n}]+)(,?)`
      );
      let updatedBody;
      if (propRe.test(bodyStr)) {
        updatedBody = bodyStr.replace(propRe, (_, p1, p2) => `${p1}${serializedVal}${p2}`);
      } else {
        const sep = bodyStr.trimEnd().endsWith(',') || bodyStr.trim() === '' ? '' : ',';
        updatedBody = `${bodyStr.trimEnd()}${sep}\n      ${propName}: ${serializedVal},\n    `;
      }
      content = `${content.slice(0, openBraceIdx + 1)}${updatedBody}${content.slice(closeBraceIdx)}`;
    } else if (new RegExp(`\\bstatic\\s+${safeMethodRe}\\s*\\(`).test(content)) {
      throw new Error(
        `Cannot safely patch non-literal return body in '${builderClass}.${methodName}()' (${path.relative(rootDir, targetFile)}).`
      );
    } else {
      const newMethod = `\n  static ${methodName}() {\n    return {\n      ${propName}: ${serializedVal},\n    };\n  }\n`;
      const clsMatch = content.match(new RegExp(`\\bclass\\s+${escapeRegExp(builderClass)}\\b[^{]*\\{`));
      if (clsMatch) {
        let depth = 0;
        let closeIdx = -1;
        for (let i = clsMatch.index + clsMatch[0].length - 1; i < content.length; i++) {
          if (content[i] === '{') depth++;
          else if (content[i] === '}') {
            depth--;
            if (depth === 0) {
              closeIdx = i;
              break;
            }
          }
        }
        if (closeIdx >= 0) {
          content = `${content.slice(0, closeIdx)}${newMethod}${content.slice(closeIdx)}`;
        } else {
          content = content.replace(/\}\s*$/, () => `${newMethod}}\n`);
        }
      } else {
        content = content.replace(/\}\s*$/, () => `${newMethod}}\n`);
      }
    }
    pendingWrites.set(targetFile, content);
    applied.push({ builderClass, methodName, propName, file: path.relative(rootDir, targetFile) });
  }

  if (!dryRun && pendingWrites.size > 0) {
    fs.mkdirSync(dataDir, { recursive: true });
    for (const [file, text] of pendingWrites.entries()) {
      fs.writeFileSync(file, text, 'utf8');
    }
  }
  return applied;
}

export function patchTape(
  rootDir,
  scenarioId,
  {
    setTitle,
    setCharter,
    addTags = [],
    removeTags = [],
    setSteps = [],
    removeSteps = [],
    setExpects = [],
    addExpects = [],
    removeExpects = [],
    setData = [],
    dryRun = false,
  } = {}
) {
  const { safeId, data } = readTape(rootDir, scenarioId);
  const updated = JSON.parse(JSON.stringify(data));

  if (setTitle) updated.title = setTitle;
  if (setCharter) updated.charter = setCharter;

  if (addTags.length > 0 || removeTags.length > 0) {
    const tagSet = new Set(Array.isArray(updated.tags) ? updated.tags : []);
    for (const t of addTags) tagSet.add(t.startsWith('@') ? t : `@${t}`);
    for (const t of removeTags) tagSet.delete(t.startsWith('@') ? t : `@${t}`);
    updated.tags = [...tagSet];
  }

  if (removeSteps.length > 0 && Array.isArray(updated.semanticSteps)) {
    const dropSet = new Set(removeSteps.map(Number));
    updated.semanticSteps = updated.semanticSteps
      .filter((st) => !dropSet.has(Number(st.stepIndex)))
      .map((st, idx) => ({ ...st, stepIndex: idx + 1 }));
  }

  for (const patch of setSteps) {
    const step = (updated.semanticSteps || []).find((s) => Number(s.stepIndex) === Number(patch.stepIndex));
    if (!step) {
      throw new Error(`Step ${patch.stepIndex} not found in tape '${safeId}'.`);
    }
    if (!ALLOWED_STEP_PATCH_FIELDS.has(patch.field)) {
      throw new Error(
        `Unsupported step field '${patch.field}'. Allowed: ${[...ALLOWED_STEP_PATCH_FIELDS].join(', ')}`
      );
    }
    if (patch.value === '' || patch.value === '__delete__') {
      delete step[patch.field];
    } else {
      step[patch.field] = patch.value;
    }
  }

  if (!Array.isArray(updated.expectedStates)) updated.expectedStates = [];

  if (removeExpects.length > 0) {
    const dropIdx = new Set(removeExpects.map((n) => Number(n) - 1));
    updated.expectedStates = updated.expectedStates.filter((_, idx) => !dropIdx.has(idx));
  }

  for (const patch of setExpects) {
    const target = updated.expectedStates[Number(patch.index) - 1];
    if (!target) {
      throw new Error(`expectedStates[${patch.index}] not found in tape '${safeId}'.`);
    }
    if (!ALLOWED_EXPECT_PATCH_FIELDS.has(patch.field)) {
      throw new Error(
        `Unsupported expectedState field '${patch.field}'. Allowed: ${[...ALLOWED_EXPECT_PATCH_FIELDS].join(', ')}`
      );
    }
    target[patch.field] = patch.value;
  }

  const BOOLEAN_ASSERTIONS = new Set(['toBeVisible', 'toBeHidden', 'toBeEnabled', 'toBeDisabled', 'toBeChecked']);
  for (const exp of addExpects) {
    const resolvedValRef =
      exp.expectedValueRef || (BOOLEAN_ASSERTIONS.has(exp.assertionType) ? 'true' : undefined);
    const resolvedTargetProp = exp.targetProperty || 'root';
    updated.expectedStates.push({
      description: exp.description || `Verify ${exp.targetComponent}.${resolvedTargetProp} ${exp.assertionType}`,
      assertionType: exp.assertionType,
      targetComponent: exp.targetComponent,
      targetProperty: resolvedTargetProp,
      ...(resolvedValRef ? { expectedValueRef: resolvedValRef } : {}),
    });
  }

  // Validate both tape and all --set-data overrides before writing anything to disk
  if (setData && setData.length > 0) {
    applyBuilderDataOverrides(rootDir, setData, { dryRun: true });
  }
  const res = writeValidatedTape(rootDir, safeId, updated, { dryRun });
  const dataUpdates = applyBuilderDataOverrides(rootDir, setData, { dryRun });
  return { ...res, tape: updated, dataUpdates };
}

function parseKeyVal(raw) {
  const eq = String(raw || '').indexOf('=');
  if (eq <= 0) throw new Error(`Expected field=value pair, got '${raw}'.`);
  return { field: raw.slice(0, eq).trim(), value: raw.slice(eq + 1) };
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(__filename);
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(__filename);
  }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(`Cortex Tape CLI (npx cortex tape)
  list [--json]
  show <scenarioId> [--json]
  clone <srcId> <newId> [--title "..."] [--charter "..."] [--tags "@p1,@neg"] [--persona-role "..."] [--persona-builder "..."] [--dry-run] [--json]
  patch <scenarioId> [--set-title "..."] [--set-charter "..."] [--add-tag "@tag"] [--remove-tag "@tag"]
                     [--set-data "Builder.fn().prop=val"] [--set-step <idx> <field=val>] [--remove-step <idx>]
                     [--set-expect <idx> <field=val>] [--add-expect "Target|assertion|value"] [--remove-expect <idx>] [--dry-run] [--json]`);
    process.exit(0);
  }

  let jsonOnly = false;
  let dryRun = false;
  const requireVal = (arr, idx, flag) => {
    const val = arr[idx];
    if (val === undefined || val.startsWith('--')) {
      throw new Error(`Missing value for flag '${flag}'.`);
    }
    return val;
  };

  try {
    if (sub === 'list') {
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--json') jsonOnly = true;
        else throw new Error(`Unknown flag '${args[i]}' for 'list'.`);
      }
      const items = listTapes(process.cwd());
      if (jsonOnly) {
        console.log(JSON.stringify(items));
      } else if (items.length === 0) {
        console.log('TAPES | none');
      } else {
        for (const t of items) {
          console.log(
            `TAPE | ${t.scenarioId} | ${t.steps}s/${t.expects}e | ${t.compiled ? 'compiled' : 'uncompiled'} | ${t.tags.join(' ')}`
          );
        }
      }
    } else if (sub === 'show') {
      const pos = [];
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--json') jsonOnly = true;
        else if (args[i].startsWith('--')) throw new Error(`Unknown flag '${args[i]}' for 'show'.`);
        else pos.push(args[i]);
      }
      const id = pos[0];
      if (!id) throw new Error('Usage: npx cortex tape show <scenarioId>');
      const { data } = readTape(process.cwd(), id);
      console.log(jsonOnly ? JSON.stringify(data) : summarizeTapeCompact(data));
    } else if (sub === 'clone') {
      const pos = [];
      const cloneOpts = { setData: [] };
      for (let i = 1; i < args.length; i++) {
        const a = args[i];
        if (a === '--json') jsonOnly = true;
        else if (a === '--dry-run') dryRun = true;
        else if (a === '--title') cloneOpts.title = requireVal(args, ++i, a);
        else if (a === '--charter') cloneOpts.charter = requireVal(args, ++i, a);
        else if (a === '--tags') {
          cloneOpts.tags = requireVal(args, ++i, a)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        } else if (a === '--persona-role') cloneOpts.personaRole = requireVal(args, ++i, a);
        else if (a === '--persona-builder') cloneOpts.personaBuilder = requireVal(args, ++i, a);
        else if (a === '--set-data') {
          const kv = requireVal(args, ++i, a);
          const eqIdx = kv.indexOf('=');
          if (eqIdx <= 0) {
            throw new Error(`Invalid --set-data '${kv}'. Expected 'BuilderClass.method().property=value'.`);
          }
          cloneOpts.setData.push({ ref: kv.slice(0, eqIdx).trim(), value: kv.slice(eqIdx + 1) });
        } else if (a.startsWith('--')) throw new Error(`Unknown flag '${a}' for 'clone'.`);
        else pos.push(a);
      }
      const [srcId, newId] = pos;
      if (!srcId || !newId) throw new Error('Usage: npx cortex tape clone <srcId> <newId> [options]');
      const res = cloneTape(process.cwd(), srcId, newId, { ...cloneOpts, dryRun });
      if (jsonOnly) {
        console.log(JSON.stringify({ action: dryRun ? 'dry-run' : 'cloned', file: res.relFile, tape: res.tape }));
      } else {
        console.log(
          `${dryRun ? 'DRY-RUN' : 'CLONED'} | ${res.relFile}\n${summarizeTapeCompact(res.tape)}`
        );
      }
    } else if (sub === 'patch') {
      const pos = [];
      const opts = {
        addTags: [],
        removeTags: [],
        setSteps: [],
        removeSteps: [],
        setExpects: [],
        addExpects: [],
        removeExpects: [],
        setData: [],
        dryRun: false,
      };
      for (let i = 1; i < args.length; i++) {
        const a = args[i];
        if (a === '--json') jsonOnly = true;
        else if (a === '--dry-run') dryRun = true;
        else if (a === '--set-title') opts.setTitle = requireVal(args, ++i, a);
        else if (a === '--set-charter') opts.setCharter = requireVal(args, ++i, a);
        else if (a === '--add-tag') opts.addTags.push(requireVal(args, ++i, a));
        else if (a === '--remove-tag') opts.removeTags.push(requireVal(args, ++i, a));
        else if (a === '--remove-step') opts.removeSteps.push(Number(requireVal(args, ++i, a)));
        else if (a === '--set-data') {
          const kv = parseKeyVal(requireVal(args, ++i, a));
          opts.setData.push({ ref: kv.field, value: kv.value });
        } else if (a === '--set-step') {
          const stepIndex = Number(requireVal(args, ++i, a));
          const kv = parseKeyVal(requireVal(args, ++i, a));
          opts.setSteps.push({ stepIndex, ...kv });
        } else if (a === '--remove-expect') opts.removeExpects.push(Number(requireVal(args, ++i, a)));
        else if (a === '--set-expect') {
          const index = Number(requireVal(args, ++i, a));
          const kv = parseKeyVal(requireVal(args, ++i, a));
          opts.setExpects.push({ index, ...kv });
        } else if (a === '--add-expect') {
          const parts = requireVal(args, ++i, a).split('|').map((s) => s.trim());
          if (parts.length >= 4) {
            opts.addExpects.push({
              targetComponent: parts[0],
              targetProperty: parts[1],
              assertionType: parts[2],
              expectedValueRef: parts.slice(3).join('|') || undefined,
            });
          } else {
            const [rawTarget, assertionType, expectedValueRef] = parts;
            const lastDot = rawTarget.lastIndexOf('.');
            const targetComponent = lastDot > 0 ? rawTarget.slice(0, lastDot) : rawTarget;
            const targetProperty = lastDot > 0 ? rawTarget.slice(lastDot + 1) : undefined;
            opts.addExpects.push({
              targetComponent,
              targetProperty,
              assertionType,
              expectedValueRef: expectedValueRef || undefined,
            });
          }
        } else if (a.startsWith('--')) {
          throw new Error(`Unknown flag '${a}' for 'patch'.`);
        } else {
          pos.push(a);
        }
      }
      const id = pos[0];
      if (!id) throw new Error('Usage: npx cortex tape patch <scenarioId> [options]');
      opts.dryRun = dryRun;
      const res = patchTape(process.cwd(), id, opts);
      if (jsonOnly) {
        console.log(JSON.stringify({ action: dryRun ? 'dry-run' : 'patched', file: res.relFile, tape: res.tape }));
      } else {
        console.log(
          `${dryRun ? 'DRY-RUN' : 'PATCHED'} | ${res.relFile}\n${summarizeTapeCompact(res.tape)}`
        );
      }
    } else {
      throw new Error(`Unknown subcommand '${sub}'. Run 'npx cortex tape --help'.`);
    }
  } catch (err) {
    console.error(`❌ cortex tape: ${err.message}`);
    process.exit(1);
  }
}
