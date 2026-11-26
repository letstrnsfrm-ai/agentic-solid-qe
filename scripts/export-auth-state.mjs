#!/usr/bin/env node
/**
 * Export cookies and localStorage from an active `agent-browser` session
 * into a Playwright-compatible `storageState` JSON file (e.g. `.auth/standard.json`).
 *
 * Usage:
 *   node scripts/export-auth-state.mjs --session auth --out .auth/standard.json
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const args = { session: 'auth', out: '.auth/default.json', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--help' || argv[i] === '-h') {
      args.help = true;
    } else if (argv[i] === '--session') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) {
        throw new Error(`Missing or invalid value for --session.`);
      }
      args.session = argv[++i];
    } else if (argv[i].startsWith('--session=')) {
      args.session = argv[i].slice('--session='.length);
    } else if (argv[i] === '--out') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) {
        throw new Error(`Missing or invalid value for --out.`);
      }
      args.out = argv[++i];
    } else if (argv[i].startsWith('--out=')) {
      args.out = argv[i].slice('--out='.length);
    }
  }
  return args;
}

const SAFE_SESSION_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const SAFE_AUTH_OUT_RE = /^\.auth\/[a-zA-Z0-9_-]+\.json$/;

export function assertSafeSessionName(session) {
  const s = String(session || '').trim();
  if (!SAFE_SESSION_NAME_RE.test(s)) {
    throw new Error(
      `Security Error: Invalid --session name '${session}'. Must match /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/ (no leading hyphens, flags, or shell characters).`
    );
  }
  return s;
}

export function assertSafeAuthOutputPath(outPath, root = process.cwd()) {
  const normalized = String(outPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!SAFE_AUTH_OUT_RE.test(normalized)) {
    throw new Error(
      `Security Error: Output path '${outPath}' must match '.auth/<persona>.json' inside the repository.`
    );
  }
  const resolvedRoot = path.resolve(root);
  const authDir = path.resolve(resolvedRoot, '.auth');
  const resolvedOut = path.resolve(resolvedRoot, normalized);
  const relToAuth = path.relative(authDir, resolvedOut);
  if (relToAuth.startsWith('..') || path.isAbsolute(relToAuth)) {
    throw new Error(`Security Error: Output path '${outPath}' resolves outside '.auth/'.`);
  }
  for (const [candidate, msg] of [
    [authDir, `Security Error: Refusing to write to symbolic link directory '.auth'.`],
    [resolvedOut, `Security Error: Refusing to overwrite symbolic link '${outPath}'.`],
  ]) {
    try {
      if (fs.lstatSync(candidate).isSymbolicLink()) {
        throw new Error(msg);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  if (fs.existsSync(resolvedRoot)) {
    const realRoot = fs.realpathSync(resolvedRoot);
    let existing = resolvedOut;
    while (!fs.existsSync(existing) && existing !== resolvedRoot) {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
    const realExisting = fs.realpathSync(existing);
    const realRel = path.relative(realRoot, realExisting);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw new Error(`Security Error: Output realpath escapes repository root: '${outPath}'.`);
    }
  }
  return { authDir, resolvedOut };
}

import { resolveLocalBin } from './explore-session.mjs';

function runAgentBrowser(session, cmdArgs) {
  const safeSession = assertSafeSessionName(session);
  const { command, prefixArgs } = resolveLocalBin('agent-browser', process.cwd());
  const res = spawnSync(command, [...prefixArgs, '--session', safeSession, ...cmdArgs], {
    encoding: 'utf8',
    timeout: 15000,
    shell: false,
  });
  if (res.status !== 0) {
    throw new Error(`agent-browser ${cmdArgs.join(' ')} failed: ${res.stderr || res.stdout}`);
  }
  return (res.stdout || '').trim();
}

// agent-browser output is semi-untrusted (a page can influence localStorage
// contents, and a failed run can return a non-JSON error message), so a
// malformed payload must fail with a clean error, not a raw SyntaxError.
function parseAgentBrowserJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse agent-browser ${label} output as JSON: ${err.message}`);
  }
}

export function buildStorageState({ cookies = [], origin = '', localStorageEntries = [] } = {}) {
  const safeCookies = Array.isArray(cookies) ? cookies : [];
  const safeEntries = Array.isArray(localStorageEntries) ? localStorageEntries : [];
  const validOrigin = typeof origin === 'string' && origin !== 'null' && /^https?:\/\//i.test(origin) ? origin : '';
  const origins = validOrigin ? [{ origin: validOrigin, localStorage: safeEntries }] : [];
  return { cookies: safeCookies, origins };
}

function main() {
  const { session, out, help } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log(
      'Usage: node scripts/export-auth-state.mjs --session <name> --out .auth/<persona>.json'
    );
    process.exit(0);
  }
  const root = process.cwd();
  const safeSession = assertSafeSessionName(session);
  const { authDir, resolvedOut } = assertSafeAuthOutputPath(out, root);

  const cookiesRaw = runAgentBrowser(safeSession, ['cookies', 'get', '--json']);
  const parsedCookies = cookiesRaw ? parseAgentBrowserJson(cookiesRaw, 'cookies') : [];
  const cookies = Array.isArray(parsedCookies)
    ? parsedCookies
    : Array.isArray(parsedCookies?.cookies)
      ? parsedCookies.cookies
      : [];

  const origin = runAgentBrowser(safeSession, ['eval', '() => location.origin']).replace(/^"|"$/g, '');
  const lsRaw = runAgentBrowser(safeSession, [
    'eval',
    '() => Object.entries(localStorage).map(([name, value]) => ({ name, value }))',
  ]);
  const parsedLs = lsRaw ? parseAgentBrowserJson(lsRaw, 'localStorage') : [];
  const localStorageEntries = Array.isArray(parsedLs) ? parsedLs : [];

  const state = buildStorageState({ cookies, origin, localStorageEntries });
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(authDir, 0o700);
  } catch {}
  const tmpOut = `${resolvedOut}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpOut, JSON.stringify(state, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  try {
    fs.chmodSync(tmpOut, 0o600);
  } catch {}
  fs.renameSync(tmpOut, resolvedOut);
  console.log(`Exported Playwright storageState (${cookies.length} cookies, ${localStorageEntries.length} localStorage keys) -> ${out}`);
}

const isCli =
  Boolean(process.argv[1]) &&
  fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isCli) {
  main();
}
