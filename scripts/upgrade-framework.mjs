#!/usr/bin/env node
/**
 * Dynamic Release Resolver & Incremental Upgrader (`cortex upgrade`).
 *
 * Resolves the latest GitHub Release tag (or `--to <tag>`) while keeping
 * consumer installs tag-pinned for supply-chain safety, then runs `sync`.
 *
 * Usage:
 *   npx cortex upgrade [--check] [--to <tag>] [--dry-run] [--force] [--squad <name>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_SLUG = 'letstrnsfrm-ai/agentic-solid-qe';
const REPO_GIT_URL = `https://github.com/${REPO_SLUG}.git`;
const RELEASES_API_URL = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`;
const SEMVER_TAG_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([a-z0-9.]+))?$/i;

export function normalizeVersion(raw) {
  if (!raw) return null;
  const match = String(raw).trim().match(SEMVER_TAG_RE);
  if (!match) return null;
  const pre = match[4] ? `-${match[4]}` : '';
  return `${match[1]}.${match[2]}.${match[3]}${pre}`;
}

export function compareSemver(aRaw, bRaw) {
  const aMatch = String(aRaw || '').trim().match(SEMVER_TAG_RE);
  const bMatch = String(bRaw || '').trim().match(SEMVER_TAG_RE);
  if (!aMatch && !bMatch) return 0;
  if (!aMatch) return -1;
  if (!bMatch) return 1;

  for (let i = 1; i <= 3; i++) {
    const diff = Number(aMatch[i]) - Number(bMatch[i]);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  const aPre = aMatch[4] || '';
  const bPre = bMatch[4] || '';
  if (!aPre && bPre) return 1;
  if (aPre && !bPre) return -1;
  if (aPre === bPre) return 0;
  return aPre > bPre ? 1 : -1;
}

export function resolveInstalledVersion(targetRoot) {
  const manifestPath = path.join(targetRoot, '.agents/framework-manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const ver = normalizeVersion(manifest.version);
      if (ver) return { version: ver, source: '.agents/framework-manifest.json' };
    } catch {
      /* ignore malformed manifest */
    }
  }

  const pkgPath = path.join(targetRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const upgradeScript = pkg.scripts?.['upgrade:skills'] || '';
      const tagMatch = upgradeScript.match(/#v?(\d+\.\d+\.\d+(?:-[a-z0-9.]+)?)/i);
      if (tagMatch) {
        return { version: normalizeVersion(tagMatch[1]), source: 'package.json (upgrade:skills)' };
      }
    } catch {
      /* ignore malformed package.json */
    }
  }

  return { version: '0.0.0', source: 'untracked' };
}

export async function fetchLatestReleaseTag() {
  // 1. Try GitHub Releases API (fastest, respects published releases)
  try {
    const res = await fetch(RELEASES_API_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'agentic-solid-qe-cli',
      },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.tag_name && SEMVER_TAG_RE.test(data.tag_name)) {
        return data.tag_name.startsWith('v') ? data.tag_name : `v${data.tag_name}`;
      }
    }
  } catch {
    /* fallback to git ls-remote */
  }

  // 2. Fallback: git ls-remote --tags
  const gitRes = spawnSync('git', ['ls-remote', '--tags', '--refs', REPO_GIT_URL], {
    encoding: 'utf8',
    timeout: 8000,
  });
  if (gitRes.status === 0 && gitRes.stdout) {
    const tags = gitRes.stdout
      .split(/\r?\n/)
      .map((line) => line.split('\t')[1] || '')
      .filter((ref) => ref.startsWith('refs/tags/'))
      .map((ref) => ref.slice('refs/tags/'.length))
      .filter((tag) => SEMVER_TAG_RE.test(tag));

    if (tags.length > 0) {
      tags.sort((a, b) => compareSemver(b, a));
      return tags[0];
    }
  }

  return null;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
🔄 Cortex Upgrade — Tag-Pinned Incremental Framework Upgrader

Usage:
  npx cortex upgrade [target-dir] [options]

Options:
  --check           Check current vs. latest release version without modifying files
  --to <tag>        Upgrade to a specific release tag (e.g. v0.9.1)
  --dry-run         Preview all sync changes without writing to disk
  --force           Overwrite locally edited framework-managed files (still preserves local-overrides.md)
  --squad <name>    Scaffold or sync a Tier 1 Squad Sub-Hub
`);
    process.exit(0);
  }

  let checkOnly = false;
  let dryRun = false;
  let force = false;
  let explicitTag = '';
  let squadName = '';
  let targetDir = '.';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--check') checkOnly = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--force') force = true;
    else if (arg === '--to' && args[i + 1]) explicitTag = args[++i];
    else if (arg.startsWith('--to=')) explicitTag = arg.slice('--to='.length);
    else if (arg === '--squad' && args[i + 1]) squadName = args[++i];
    else if (arg.startsWith('--squad=')) squadName = arg.slice('--squad='.length);
    else if (!arg.startsWith('-')) targetDir = arg;
  }

  const targetRoot = path.resolve(process.cwd(), targetDir);
  const current = resolveInstalledVersion(targetRoot);

  let targetTag = '';
  if (explicitTag) {
    if (!SEMVER_TAG_RE.test(explicitTag)) {
      console.error(`❌ Invalid release tag '${explicitTag}'. Expected semver tag like v0.9.1.`);
      process.exit(1);
    }
    targetTag = explicitTag.startsWith('v') ? explicitTag : `v${explicitTag}`;
  } else {
    console.log(`🔎 Checking latest release for ${REPO_SLUG}...`);
    targetTag = (await fetchLatestReleaseTag()) || '';
    if (!targetTag) {
      console.error(
        `❌ Could not resolve latest release tag from GitHub (offline or rate-limited). Pass '--to <tag>' explicitly or run 'npx --yes github:${REPO_SLUG}#v0.9.1 sync'.`
      );
      process.exit(1);
    }
  }

  const targetVer = normalizeVersion(targetTag);
  const cmp = compareSemver(targetVer, current.version);

  console.log(`📦 Installed version : ${current.version} (from ${current.source})`);
  console.log(`🚀 Target release    : ${targetTag}`);

  if (checkOnly) {
    if (cmp > 0) {
      console.log(`\n✨ Update available: ${current.version} -> ${targetVer}`);
      console.log(`   Run: npx --yes github:${REPO_SLUG}#${targetTag} sync ${targetDir === '.' ? '' : targetDir}`.trim());
    } else {
      console.log(`\n✅ Already up to date (${current.version}).`);
    }
    process.exit(0);
  }

  const syncFlags = ['--yes', `github:${REPO_SLUG}#${targetTag}`, 'sync', targetRoot];
  if (dryRun) syncFlags.push('--dry-run');
  if (force) syncFlags.push('--force');
  if (squadName) syncFlags.push('--squad', squadName);

  console.log(`\n⚡ Running: npx ${syncFlags.join(' ')}\n`);
  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const res = spawnSync(npxCmd, syncFlags, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  process.exit(res.status ?? 0);
}

const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  main().catch((err) => {
    console.error(`❌ Upgrade failed: ${err?.message || err}`);
    process.exit(1);
  });
}
