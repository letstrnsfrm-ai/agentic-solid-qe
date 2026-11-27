/**
 * Operational QE Ontology — Core constants, safe file loading, and src/ symbol collector.
 * Zero external runtime dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';

export const MAX_FILE_BYTES = 1024 * 1024; // 1 MB cap
export const ONTOLOGY_REL_PATH = '.agents/domain/ontology.json';
export const ONTOLOGY_SCHEMA_REL_PATH = '.agents/domain/ontology.schema.json';

export const FORBIDDEN_KEYS = new Set([
  '__proto__',
  'prototype',
  'constructor',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);

export const VALID_RELATIONS = new Set([
  'contains',
  'creates',
  'owns',
  'references',
  'mutates',
  'authenticates',
  'triggers',
  'depends_on',
]);
export const VALID_CARDINALITIES = new Set(['1:1', '1:N', 'N:1', 'N:M']);
export const VALID_SEVERITIES = new Set(['p0', 'p1', 'p2']);
export const VALID_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export const ID_REGEX = /^[A-Za-z][A-Za-z0-9_-]*$/;
export const KEBAB_REGEX = /^[a-z0-9-]+$/;
export const STATE_REGEX = /^[a-z0-9_-]+$/;
export const CLASS_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const SQUAD_REGEX = /^@[a-z0-9-]+\/[a-z0-9-]+$/;
export const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
export const TRANSITION_REF_REGEX = /^([A-Za-z][A-Za-z0-9_-]*):([a-z0-9_-]+)->([a-z0-9_-]+)$/;

export function isWithinDir(targetPath, baseDir) {
  const rel = path.relative(baseDir, targetPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function isSafeWorkspaceFile(rootDir, targetPath) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);
  if (!isWithinDir(resolvedTarget, resolvedRoot)) return false;
  let cur = resolvedTarget;
  while (cur !== resolvedRoot) {
    try {
      if (fs.lstatSync(cur).isSymbolicLink()) return false;
    } catch {
      return false;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  try {
    const realRoot = fs.realpathSync(resolvedRoot);
    const realTarget = fs.realpathSync(resolvedTarget);
    if (!isWithinDir(realTarget, realRoot)) return false;
    const st = fs.lstatSync(resolvedTarget);
    return st.isFile() && st.size <= MAX_FILE_BYTES;
  } catch {
    return false;
  }
}

export function walkFiles(dir, extFilter) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      files.push(...walkFiles(full, extFilter));
    } else if (!extFilter || full.endsWith(extFilter)) {
      try {
        const st = fs.lstatSync(full);
        if (st.isFile() && st.size <= MAX_FILE_BYTES) files.push(full);
      } catch {
        /* skip unreadable */
      }
    }
  }
  return files.sort();
}

export function checkKeys(obj, allowed, label, errors) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  for (const key of Object.getOwnPropertyNames(obj)) {
    if (FORBIDDEN_KEYS.has(key)) {
      errors.push(`${label} Forbidden prototype property '${key}' is not allowed.`);
    } else if (!allowed.has(key)) {
      errors.push(`${label} Unknown property '${key}' is not allowed by ontology.schema.json.`);
    }
  }
}

/**
 * Safely loads `.agents/domain/ontology.json` from `rootDir`.
 * Returns `{ exists, path, ontology, parseError }`.
 */
export function loadOntology(rootDir = process.cwd()) {
  const fullPath = path.join(rootDir, ONTOLOGY_REL_PATH);
  if (!fs.existsSync(fullPath)) {
    return { exists: false, path: ONTOLOGY_REL_PATH, ontology: null, parseError: null };
  }
  if (!isSafeWorkspaceFile(rootDir, fullPath)) {
    return {
      exists: true,
      path: ONTOLOGY_REL_PATH,
      ontology: null,
      parseError: `Security Error: Refusing to read ${ONTOLOGY_REL_PATH} (symlink, outside workspace, or >1MB).`,
    };
  }
  try {
    const raw = fs.readFileSync(fullPath, 'utf8');
    const parsed = JSON.parse(raw);
    return { exists: true, path: ONTOLOGY_REL_PATH, ontology: parsed, parseError: null };
  } catch (err) {
    return {
      exists: true,
      path: ONTOLOGY_REL_PATH,
      ontology: null,
      parseError: `Invalid JSON in ${ONTOLOGY_REL_PATH}: ${err.message}`,
    };
  }
}

/**
 * Collects exported class names from `src/` so ontology component/builder refs can be verified.
 */
export function collectSrcClassNames(rootDir) {
  const srcDir = path.join(rootDir, 'src');
  const classToFile = Object.create(null);
  if (!fs.existsSync(srcDir)) return classToFile;
  for (const f of walkFiles(srcDir, '.ts')) {
    let content = '';
    try {
      content = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const rel = path.relative(rootDir, f).replace(/\\/g, '/');
    for (const m of content.matchAll(/\bexport\s+(?:abstract\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
      classToFile[m[1]] = rel;
    }
  }
  return classToFile;
}
