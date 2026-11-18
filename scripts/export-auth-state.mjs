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

function runAgentBrowser(session, cmdArgs) {
  const res = spawnSync('npx', ['--no-install', 'agent-browser', '--session', session, ...cmdArgs], {
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
  const resolvedOut = path.resolve(root, out);
  if (!resolvedOut.startsWith(root + path.sep)) {
    throw new Error(`Security Error: Output path '${out}' must stay inside the repository root.`);
  }

  const cookiesRaw = runAgentBrowser(session, ['cookies', 'get', '--json']);
  const parsedCookies = cookiesRaw ? JSON.parse(cookiesRaw) : [];
  const cookies = Array.isArray(parsedCookies) ? parsedCookies : parsedCookies.cookies || [];

  const origin = runAgentBrowser(session, ['eval', '() => location.origin']).replace(/^"|"$/g, '');
  const lsRaw = runAgentBrowser(session, [
    'eval',
    '() => Object.entries(localStorage).map(([name, value]) => ({ name, value }))',
  ]);
  const localStorageEntries = lsRaw ? JSON.parse(lsRaw) : [];

  const state = buildStorageState({ cookies, origin, localStorageEntries });
  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
  fs.writeFileSync(resolvedOut, JSON.stringify(state, null, 2) + '\n', 'utf8');
  console.log(`Exported Playwright storageState (${cookies.length} cookies, ${localStorageEntries.length} localStorage keys) -> ${out}`);
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isCli) {
  main();
}
