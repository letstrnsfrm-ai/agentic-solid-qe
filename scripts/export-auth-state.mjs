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

function parseArgs(argv) {
  const args = { session: 'auth', out: '.auth/default.json' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--session' && argv[i + 1]) {
      args.session = argv[++i];
    } else if (argv[i] === '--out' && argv[i + 1]) {
      args.out = argv[++i];
    }
  }
  return args;
}

const SAFE_SESSION_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const SAFE_AUTH_OUT_RE = /^\.auth\/[a-zA-Z0-9_-]+\.json$/;

export function assertSafeSessionName(session) {
  const s = String(session || '').trim();
  if (!SAFE_SESSION_NAME_RE.test(s)) {
    throw new Error(
      `Security Error: Invalid --session name '${session}'. Must match /^[a-zA-Z0-9_-]{1,64}$/ (no flags or shell characters).`
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
  const authDir = path.resolve(root, '.auth');
  const resolvedOut = path.resolve(root, normalized);
  const relToAuth = path.relative(authDir, resolvedOut);
  if (relToAuth.startsWith('..') || path.isAbsolute(relToAuth)) {
    throw new Error(`Security Error: Output path '${outPath}' resolves outside '.auth/'.`);
  }
  if (fs.existsSync(authDir) && fs.lstatSync(authDir).isSymbolicLink()) {
    throw new Error(`Security Error: Refusing to write to symbolic link directory '.auth'.`);
  }
  if (fs.existsSync(resolvedOut) && fs.lstatSync(resolvedOut).isSymbolicLink()) {
    throw new Error(`Security Error: Refusing to overwrite symbolic link '${outPath}'.`);
  }
  return { authDir, resolvedOut };
}

function runAgentBrowser(session, cmdArgs) {
  const safeSession = assertSafeSessionName(session);
  const res = spawnSync('npx', ['--no-install', 'agent-browser', '--session', safeSession, ...cmdArgs], {
    encoding: 'utf8',
    timeout: 15000,
  });
  if (res.status !== 0) {
    throw new Error(`agent-browser ${cmdArgs.join(' ')} failed: ${res.stderr || res.stdout}`);
  }
  return (res.stdout || '').trim();
}

export function buildStorageState({ cookies = [], origin = '', localStorageEntries = [] }) {
  const origins =
    origin && localStorageEntries.length > 0
      ? [{ origin, localStorage: localStorageEntries }]
      : [];
  return { cookies, origins };
}

function main() {
  const { session, out } = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const safeSession = assertSafeSessionName(session);
  const { authDir, resolvedOut } = assertSafeAuthOutputPath(out, root);

  const cookiesRaw = runAgentBrowser(safeSession, ['cookies', 'get', '--json']);
  const parsedCookies = cookiesRaw ? JSON.parse(cookiesRaw) : [];
  const cookies = Array.isArray(parsedCookies) ? parsedCookies : parsedCookies.cookies || [];

  const origin = runAgentBrowser(safeSession, ['eval', '() => location.origin']).replace(/^"|"$/g, '');
  const lsRaw = runAgentBrowser(safeSession, [
    'eval',
    '() => Object.entries(localStorage).map(([name, value]) => ({ name, value }))',
  ]);
  const localStorageEntries = lsRaw ? JSON.parse(lsRaw) : [];

  const state = buildStorageState({ cookies, origin, localStorageEntries });
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(resolvedOut, JSON.stringify(state, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    fs.chmodSync(authDir, 0o700);
    fs.chmodSync(resolvedOut, 0o600);
  } catch {
    /* ignore chmod no-op on non-POSIX platforms */
  }
  console.log(`Exported Playwright storageState (${cookies.length} cookies, ${localStorageEntries.length} localStorage keys) -> ${out}`);
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isCli) {
  main();
}
