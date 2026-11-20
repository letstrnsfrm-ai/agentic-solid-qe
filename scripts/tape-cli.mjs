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

function resolveTapePath(rootDir, scenarioId) {
  const safeId = assertSafeScenarioId(scenarioId);
  const tapesDir = path.resolve(rootDir, '.exploratory/tapes');
  const full = path.resolve(tapesDir, `${safeId}.json`);
  if (!full.startsWith(tapesDir + path.sep)) {
    throw new Error(`Refusing path outside .exploratory/tapes: ${full}`);
  }
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
    fs.mkdirSync(tapesDir, { recursive: true });
    fs.writeFileSync(full, JSON.stringify(tapeObj, null, 2) + '\n', 'utf8');
  }
  return { safeId, relFile, written: !dryRun };
}

export function listTapes(rootDir = process.cwd()) {
  const tapesDir = path.join(rootDir, '.exploratory/tapes');
  if (!fs.existsSync(tapesDir)) return [];
  const specsDir = path.join(rootDir, 'tests');
  const specSources = fs.existsSync(specsDir)
    ? fs
        .readdirSync(specsDir)
        .filter((f) => f.endsWith('.spec.ts'))
        .map((f) => ({ file: f, content: fs.readFileSync(path.join(specsDir, f), 'utf8') }))
    : [];

  return fs
    .readdirSync(tapesDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const data = JSON.parse(fs.readFileSync(path.join(tapesDir, f), 'utf8'));
      const id = data.scenarioId || path.basename(f, '.json');
      const compiled = specSources.some(
        (s) => s.file.includes(id) || s.content.includes(id) || s.content.includes(`${id}.json`)
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

export function cloneTape(
  rootDir,
  srcId,
  newId,
  { title, charter, tags, personaRole, personaBuilder, dryRun = false } = {}
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
  }
  if (personaRole || personaBuilder) {
    cloned.persona = { ...(cloned.persona || {}) };
    if (personaRole) cloned.persona.role = personaRole;
    if (personaBuilder) cloned.persona.dataBuilderRef = personaBuilder;
  }
  const res = writeValidatedTape(rootDir, safeNewId, cloned, { dryRun });
  return { ...res, tape: cloned };
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
    updated.expectedStates.push({
      description: exp.description || `Verify ${exp.targetComponent}${exp.targetProperty ? `.${exp.targetProperty}` : ''} ${exp.assertionType}`,
      assertionType: exp.assertionType,
      targetComponent: exp.targetComponent,
      ...(exp.targetProperty ? { targetProperty: exp.targetProperty } : {}),
      ...(resolvedValRef ? { expectedValueRef: resolvedValRef } : {}),
    });
  }

  const res = writeValidatedTape(rootDir, safeId, updated, { dryRun });
  return { ...res, tape: updated };
}

function parseKeyVal(raw) {
  const eq = String(raw || '').indexOf('=');
  if (eq <= 0) throw new Error(`Expected field=value pair, got '${raw}'.`);
  return { field: raw.slice(0, eq).trim(), value: raw.slice(eq + 1) };
}

const isMain =
  Boolean(process.argv[1]) &&
  fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(__filename);

if (isMain) {
  const args = process.argv.slice(2);
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(`Cortex Tape CLI (npx cortex tape)
  list [--json]
  show <scenarioId> [--json]
  clone <srcId> <newId> [--title "..."] [--charter "..."] [--tags "@p1,@neg"] [--persona-role "..."] [--persona-builder "..."] [--dry-run]
  patch <scenarioId> [--set-title "..."] [--set-charter "..."] [--add-tag "@tag"] [--remove-tag "@tag"]
                     [--set-step <idx> <field=val>] [--remove-step <idx>]
                     [--set-expect <idx> <field=val>] [--add-expect "Target|assertion|value"] [--remove-expect <idx>] [--dry-run]`);
    process.exit(0);
  }

  const jsonOnly = args.includes('--json');
  const dryRun = args.includes('--dry-run');

  try {
    if (sub === 'list') {
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
      const id = args[1];
      if (!id) throw new Error('Usage: npx cortex tape show <scenarioId>');
      const { data } = readTape(process.cwd(), id);
      console.log(jsonOnly ? JSON.stringify(data) : summarizeTapeCompact(data));
    } else if (sub === 'clone') {
      const [, srcId, newId] = args;
      if (!srcId || !newId) throw new Error('Usage: npx cortex tape clone <srcId> <newId> [options]');
      const getVal = (flag) => {
        const i = args.indexOf(flag);
        return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
      };
      const tagsRaw = getVal('--tags');
      const res = cloneTape(process.cwd(), srcId, newId, {
        title: getVal('--title'),
        charter: getVal('--charter'),
        tags: tagsRaw ? tagsRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        personaRole: getVal('--persona-role'),
        personaBuilder: getVal('--persona-builder'),
        dryRun,
      });
      console.log(
        `${dryRun ? 'DRY-RUN' : 'CLONED'} | ${res.relFile}\n${summarizeTapeCompact(res.tape)}`
      );
    } else if (sub === 'patch') {
      const id = args[1];
      if (!id) throw new Error('Usage: npx cortex tape patch <scenarioId> [options]');
      const opts = {
        addTags: [],
        removeTags: [],
        setSteps: [],
        removeSteps: [],
        setExpects: [],
        addExpects: [],
        removeExpects: [],
        dryRun,
      };
      for (let i = 2; i < args.length; i++) {
        const a = args[i];
        if (a === '--set-title' && args[i + 1]) opts.setTitle = args[++i];
        else if (a === '--set-charter' && args[i + 1]) opts.setCharter = args[++i];
        else if (a === '--add-tag' && args[i + 1]) opts.addTags.push(args[++i]);
        else if (a === '--remove-tag' && args[i + 1]) opts.removeTags.push(args[++i]);
        else if (a === '--remove-step' && args[i + 1]) opts.removeSteps.push(Number(args[++i]));
        else if (a === '--set-step' && args[i + 1] && args[i + 2]) {
          const stepIndex = Number(args[++i]);
          const kv = parseKeyVal(args[++i]);
          opts.setSteps.push({ stepIndex, ...kv });
        } else if (a === '--remove-expect' && args[i + 1]) opts.removeExpects.push(Number(args[++i]));
        else if (a === '--set-expect' && args[i + 1] && args[i + 2]) {
          const index = Number(args[++i]);
          const kv = parseKeyVal(args[++i]);
          opts.setExpects.push({ index, ...kv });
        } else if (a === '--add-expect' && args[i + 1]) {
          const parts = args[++i].split('|').map((s) => s.trim());
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
        }
      }
      const res = patchTape(process.cwd(), id, opts);
      console.log(
        `${dryRun ? 'DRY-RUN' : 'PATCHED'} | ${res.relFile}\n${summarizeTapeCompact(res.tape)}`
      );
    } else {
      throw new Error(`Unknown subcommand '${sub}'. Run 'npx cortex tape --help'.`);
    }
  } catch (err) {
    console.error(`❌ cortex tape: ${err.message}`);
    process.exit(1);
  }
}
