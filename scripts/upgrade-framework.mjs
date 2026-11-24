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
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_REPO_SLUG = 'letstrnsfrm-ai/agentic-solid-qe';
const SAFE_REPO_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const SAFE_SQUAD_NAME_RE = /^[a-z0-9][a-z0-9-]*$/i;
const SEMVER_TAG_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const MAX_TARBALL_BYTES = 50 * 1024 * 1024; // 50 MB download cap
const ALLOWED_TARBALL_HOSTS = new Set(['codeload.github.com', 'objects.githubusercontent.com']);

export function isEnterpriseOfflineMode(env = process.env) {
  return (
    env.CORTEX_OFFLINE === '1' ||
    env.CORTEX_OFFLINE === 'true' ||
    env.CORTEX_NO_NETWORK === '1' ||
    env.CORTEX_NO_NETWORK === 'true'
  );
}

export function resolveUpgradeRepoSlug(env = process.env) {
  const custom = (env.CORTEX_UPGRADE_REPO || '').trim();
  if (!custom) return DEFAULT_REPO_SLUG;
  if (!SAFE_REPO_SLUG_RE.test(custom) || custom.includes('..')) {
    throw new Error(
      `Security Error: Invalid CORTEX_UPGRADE_REPO '${custom}'. Must match 'owner/repo' ([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+).`
    );
  }
  return custom;
}

export function assertSafeSquadName(squadName) {
  const s = String(squadName || '').trim();
  if (!SAFE_SQUAD_NAME_RE.test(s) || s.includes('..')) {
    throw new Error(
      `Security Error: Invalid --squad '${squadName}'. Must be a kebab-case identifier ([a-z0-9-]) with no shell metacharacters.`
    );
  }
  return s.toLowerCase();
}

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
  const aParts = aPre.split('.');
  const bParts = bPre.split('.');
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    if (i >= aParts.length) return -1;
    if (i >= bParts.length) return 1;
    const ap = aParts[i];
    const bp = bParts[i];
    if (ap === bp) continue;
    const aNum = /^\d+$/.test(ap);
    const bNum = /^\d+$/.test(bp);
    if (aNum && bNum) return Number(ap) > Number(bp) ? 1 : -1;
    if (aNum) return -1;
    if (bNum) return 1;
    return ap > bp ? 1 : -1;
  }
  return 0;
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
      const tagMatch = upgradeScript.match(/#v?(\d+\.\d+\.\d+(?:-[0-9a-z-]+(?:\.[0-9a-z-]+)*)?)/i);
      if (tagMatch) {
        const ver = normalizeVersion(tagMatch[1]);
        if (ver) return { version: ver, source: 'package.json (upgrade:skills)' };
      }
    } catch {
      /* ignore malformed package.json */
    }
  }

  return { version: '0.0.0', source: 'untracked' };
}

export async function fetchLatestReleaseTag(repoSlug = resolveUpgradeRepoSlug()) {
  if (isEnterpriseOfflineMode()) {
    throw new Error(
      'Security Policy: Outbound release resolution is disabled when CORTEX_OFFLINE=1 or CORTEX_NO_NETWORK=1.'
    );
  }
  const releasesApiUrl = `https://api.github.com/repos/${repoSlug}/releases/latest`;
  const repoGitUrl = `https://github.com/${repoSlug}.git`;

  // 1. Try GitHub Releases API (fastest, respects published releases)
  try {
    const res = await fetch(releasesApiUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'agentic-solid-qe-cli',
      },
      redirect: 'error',
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
  const gitRes = spawnSync('git', ['ls-remote', '--tags', '--refs', '--', repoGitUrl], {
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

function walkPatches(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkPatches(full));
    else if (entry.isFile()) results.push(full);
  }
  return results;
}

const ALLOWED_UPGRADE_PATCH_TARGETS = new Set([
  'playwright.config.ts',
  '.github/workflows/playwright-ci.yml',
  '.azure-pipelines/playwright-ci.yml',
  'tsconfig.json',
  'package.json',
  '.gitignore',
  'AGENTS.md',
  '.github/copilot-instructions.md',
  'scripts/lib/cli-output.mjs',
  'scripts/lib/autonomous-mode.mjs',
  'scripts/context-pack.mjs',
  'scripts/impact-graph.mjs',
  'scripts/tape-cli.mjs',
  'scripts/build-domain-graph.mjs',
  'scripts/build-system-map.mjs',
  'scripts/compile-tape.mjs',
  'scripts/explore-session.mjs',
  'scripts/export-auth-state.mjs',
  'scripts/heal-drift.mjs',
  'scripts/migrate-skill.mjs',
  'scripts/legacy-test-migrator.mjs',
  'scripts/dotnet-enterprise-analyzer.mjs',
  'scripts/migration-wave-factory.mjs',
  'scripts/orchestrate.mjs',
  'scripts/verify-fast.mjs',
  'scripts/analyze-coverage.mjs',
  'scripts/audit-solid.mjs',
  'scripts/validate-tapes.mjs',
  'scripts/sync-skills.mjs',
  'scripts/upgrade-framework.mjs',
  'scripts/report-cloud.mjs',
  'scripts/self-test.mjs',
]);

function assertSafePatchDestination(targetRoot, targetPath, label = 'patch target') {
  const resolvedRoot = path.resolve(targetRoot);
  const resolvedTarget = path.resolve(targetPath);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Security Error: ${label} escapes target root: '${targetPath}'.`);
  }
  let cur = resolvedTarget;
  while (cur !== resolvedRoot) {
    try {
      if (fs.lstatSync(cur).isSymbolicLink()) {
        throw new Error(`Security Error: Refusing to access symlinked ${label}: '${path.relative(resolvedRoot, cur)}'.`);
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
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
      throw new Error(`Security Error: ${label} realpath escapes target root.`);
    }
  }
  return resolvedTarget;
}

function isAllowedUpgradePatchTarget(targetRel) {
  if (ALLOWED_UPGRADE_PATCH_TARGETS.has(targetRel)) return true;
  if (targetRel === '.agents/domain/session-tape.schema.json' || targetRel === 'CHANGELOG.json') return true;
  if (
    targetRel.startsWith('.agents/skills/') ||
    targetRel.startsWith('.github/prompts/') ||
    targetRel.startsWith('.claude/commands/')
  ) {
    return !targetRel.includes('..');
  }
  return false;
}

export function collectPendingPatches(targetRoot) {
  const patchesDir = path.join(targetRoot, '.agents/upgrade-patches');
  if (!fs.existsSync(patchesDir)) return [];
  try {
    assertSafePatchDestination(targetRoot, patchesDir, 'upgrade-patches directory');
  } catch {
    return [];
  }
  const results = [];
  for (const patchPath of walkPatches(patchesDir)) {
    assertSafePatchDestination(targetRoot, patchPath, 'upgrade patch file');
    const relFromPatches = path.relative(patchesDir, patchPath).replace(/\\/g, '/');
    let targetRel = relFromPatches;
    if (relFromPatches === 'playwright.config.ts.new') targetRel = 'playwright.config.ts';
    else if (relFromPatches === 'playwright-ci.yml.new') targetRel = '.github/workflows/playwright-ci.yml';

    if (!isAllowedUpgradePatchTarget(targetRel)) {
      console.warn(`⚠️  Skipped unallowlisted upgrade patch target: ${targetRel}`);
      continue;
    }
    const targetPath = assertSafePatchDestination(targetRoot, path.join(targetRoot, targetRel), targetRel);
    results.push({
      patchPath,
      patchRel: `.agents/upgrade-patches/${relFromPatches}`,
      targetPath,
      targetRel,
    });
  }
  return results;
}

function runDiffPatches(targetRoot) {
  const patches = collectPendingPatches(targetRoot);
  if (patches.length === 0) {
    console.log('✅ No pending patches in .agents/upgrade-patches/.');
    return 0;
  }
  console.log(`\n🔍 Pending Upgrade Patches (${patches.length}):\n`);
  for (const p of patches) {
    console.log(`--- ${p.targetRel}  <=>  ${p.patchRel} ---`);
    if (!fs.existsSync(p.targetPath)) {
      console.log(`(Target file ${p.targetRel} does not exist yet; patch will create it.)\n`);
      continue;
    }
    const diffRes = spawnSync('git', ['diff', '--no-index', '--', p.targetPath, p.patchPath], {
      encoding: 'utf8',
    });
    if (diffRes.stdout) {
      console.log(diffRes.stdout);
    } else {
      console.log('(No textual differences detected.)\n');
    }
  }
  return 0;
}

function injectBlobReporterInPlaywrightConfig(content) {
  if (content.includes("['blob']")) return { changed: false, content };
  const reporterLineRe = /(\breporter:\s*)(['"][^'"]+['"]|\[[^\]]*\])(\s*,?)/;
  const match = content.match(reporterLineRe);
  if (!match) return { changed: false, content };
  const existingVal = match[2].trim();
  const trailingComma = match[3] || '';
  const replacement = `${match[1]}process.env.CI && process.env.PLAYWRIGHT_SHARD_INDEX ? [['blob']] : ${existingVal}${trailingComma}`;
  return {
    changed: true,
    content: content.replace(reporterLineRe, () => replacement),
  };
}

function runApplyPatches(targetRoot, { dryRun = false, force = false } = {}) {
  const patches = collectPendingPatches(targetRoot);
  if (patches.length === 0) {
    console.log('✅ No pending patches in .agents/upgrade-patches/.');
    return 0;
  }
  let remaining = 0;
  for (const p of patches) {
    assertSafePatchDestination(targetRoot, p.targetPath, p.targetRel);
    if (p.targetRel === 'playwright.config.ts' && fs.existsSync(p.targetPath) && !force) {
      const current = fs.readFileSync(p.targetPath, 'utf8');
      const { changed, content } = injectBlobReporterInPlaywrightConfig(current);
      if (changed) {
        if (!dryRun) {
          fs.writeFileSync(p.targetPath, content, 'utf8');
          fs.unlinkSync(p.patchPath);
        }
        console.log(
          `${dryRun ? '🔍 [DRY-RUN] Would inject' : '✨ Applied'} CI blob reporter into ${p.targetRel} and resolved ${p.patchRel}`
        );
        continue;
      }
      if (current.includes("['blob']")) {
        if (!dryRun) fs.unlinkSync(p.patchPath);
        console.log(`🧹 Removed already-satisfied patch: ${p.patchRel}`);
        continue;
      }
    }

    if (force) {
      if (!dryRun) {
        if (fs.existsSync(p.targetPath)) {
          const safeBackupRel = p.targetRel.replace(/[\\/]+/g, '__');
          const backupPath = assertSafePatchDestination(
            targetRoot,
            path.join(targetRoot, '.agents/legacy-backups', `${safeBackupRel}.pre-patch`),
            'backup file'
          );
          fs.mkdirSync(path.dirname(backupPath), { recursive: true, mode: 0o700 });
          fs.copyFileSync(p.targetPath, backupPath);
        }
        fs.mkdirSync(path.dirname(p.targetPath), { recursive: true });
        fs.copyFileSync(p.patchPath, p.targetPath);
        fs.unlinkSync(p.patchPath);
      }
      console.log(`${dryRun ? '🔍 [DRY-RUN] Would overwrite' : '🔄 Applied'} ${p.patchRel} -> ${p.targetRel}`);
    } else {
      remaining++;
      console.log(
        `⏭️  Skipped manual/AI-merge patch: ${p.targetRel} (run 'npx cortex upgrade --diff' to inspect, '--apply-patches --force' to replace, or ask /agentic-solid-qe to merge)`
      );
    }
  }
  return remaining > 0 ? 0 : 0;
}

export function isEallowgitError(output = '') {
  return /\bEALLOWGIT\b|Fetching packages of type ["']?git["']? have been disabled/i.test(String(output || ''));
}

export function buildReleaseTarballUrl(repoSlug, targetTag) {
  if (!SAFE_REPO_SLUG_RE.test(repoSlug) || repoSlug.includes('..')) {
    throw new Error(`Security Error: Invalid repo slug '${repoSlug}'.`);
  }
  if (!SEMVER_TAG_RE.test(targetTag)) {
    throw new Error(`Security Error: Invalid release tag '${targetTag}'.`);
  }
  const tag = targetTag.startsWith('v') ? targetTag : `v${targetTag}`;
  return `https://codeload.github.com/${repoSlug}/tar.gz/refs/tags/${tag}`;
}

export function validateTarArchiveEntries(entries = []) {
  for (const rawEntry of entries) {
    const entry = String(rawEntry || '').trim();
    if (!entry) continue;
    if (
      entry.includes('\0') ||
      entry.startsWith('/') ||
      entry.startsWith('\\') ||
      /^[A-Za-z]:/.test(entry) ||
      /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(entry)
    ) {
      throw new Error(`Security Error: Unsafe archive entry '${entry}' detected (Zip-Slip protection).`);
    }
  }
  return true;
}

export async function runTarballOrCloneSync({
  repoSlug,
  targetTag,
  targetRoot,
  dryRun = false,
  force = false,
  squadName = '',
} = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asqe-upgrade-'));
  try {
    let extractedDir = null;
    const tarballUrl = buildReleaseTarballUrl(repoSlug, targetTag);
    const tarballPath = path.join(tmpDir, 'release.tar.gz');
    try {
      const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      let fetchUrl = tarballUrl;
      let res = null;
      for (let hop = 0; hop < 2; hop++) {
        const parsedHop = new URL(fetchUrl);
        if (parsedHop.protocol !== 'https:' || !ALLOWED_TARBALL_HOSTS.has(parsedHop.hostname.toLowerCase())) {
          throw new Error(`Security Error: Disallowed release tarball host '${parsedHop.hostname}'.`);
        }
        const headers = { 'User-Agent': 'agentic-solid-qe-upgrader' };
        // Only attach GitHub token to codeload.github.com, never to cross-origin redirect targets
        if (token && parsedHop.hostname.toLowerCase() === 'codeload.github.com') {
          headers.Authorization = `Bearer ${token}`;
        }
        res = await fetch(fetchUrl, { headers, redirect: 'manual', signal: AbortSignal.timeout(30000) });
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location');
          if (!loc) break;
          fetchUrl = new URL(loc, fetchUrl).toString();
          continue;
        }
        break;
      }
      if (res && res.ok) {
        const contentLen = Number(res.headers.get('content-length') || 0);
        if (Number.isFinite(contentLen) && contentLen > MAX_TARBALL_BYTES) {
          throw new Error(`Security Error: Release tarball exceeds ${MAX_TARBALL_BYTES}-byte safety limit.`);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength > MAX_TARBALL_BYTES) {
          throw new Error(`Security Error: Release tarball exceeds ${MAX_TARBALL_BYTES}-byte safety limit.`);
        }
        fs.writeFileSync(tarballPath, buf, { mode: 0o600 });
        const listRes = spawnSync('tar', ['-tzf', tarballPath], {
          stdio: 'pipe',
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
        });
        if (listRes.status === 0) {
          const entries = String(listRes.stdout || '').split(/\r?\n/).filter(Boolean);
          validateTarArchiveEntries(entries);
          const extractDir = path.join(tmpDir, 'extracted');
          fs.mkdirSync(extractDir, { recursive: true, mode: 0o700 });
          const tarRes = spawnSync('tar', ['-xzf', tarballPath, '-C', extractDir, '--no-same-owner', '--no-same-permissions'], {
            stdio: 'pipe',
            encoding: 'utf8',
          });
          if (tarRes.status === 0) {
            const topEntries = fs
              .readdirSync(extractDir, { withFileTypes: true })
              .filter((d) => !d.isSymbolicLink() && d.isDirectory());
            if (topEntries.length > 0) {
              const candidateDir = path.join(extractDir, topEntries[0].name);
              assertSafePatchDestination(extractDir, candidateDir, 'extracted release directory');
              extractedDir = candidateDir;
            }
          }
        }
      }
    } catch (err) {
      if (String(err?.message || '').startsWith('Security Error:')) {
        throw err;
      }
      /* fall through to shallow git clone */
    }

    if (!extractedDir) {
      const cloneDir = path.join(tmpDir, 'repo');
      const cloneRes = spawnSync(
        'git',
        ['clone', '--branch', targetTag, '--depth', '1', '--', `https://github.com/${repoSlug}.git`, cloneDir],
        { stdio: 'inherit', shell: false }
      );
      if (cloneRes.status !== 0) {
        return cloneRes.status ?? 1;
      }
      extractedDir = cloneDir;
    }

    const syncScript = assertSafePatchDestination(
      extractedDir,
      path.join(extractedDir, 'scripts', 'sync-skills.mjs'),
      'extracted sync-skills.mjs'
    );
    if (!fs.existsSync(syncScript)) {
      console.error(`❌ Downloaded release ${targetTag} is missing scripts/sync-skills.mjs.`);
      return 1;
    }
    const nodeSyncArgs = [syncScript, 'sync', targetRoot];
    if (dryRun) nodeSyncArgs.push('--dry-run');
    if (force) nodeSyncArgs.push('--force');
    if (squadName) nodeSyncArgs.push('--squad', squadName);
    const syncRes = spawnSync(process.execPath, nodeSyncArgs, { stdio: 'inherit', shell: false });
    return syncRes.status ?? 1;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
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
  --diff            Preview unified diffs for pending files in .agents/upgrade-patches/
  --apply-patches   Safely apply pending .agents/upgrade-patches/ (use --force to replace full files with backup)
  --to <tag>        Upgrade to a specific release tag (e.g. v0.23.0)
  --dry-run         Preview all sync/patch changes without writing to disk
  --force           Overwrite locally edited framework-managed files (still preserves local-overrides.md)
  --squad <name>    Scaffold or sync a Tier 1 Squad Sub-Hub
`);
    process.exit(0);
  }

  let checkOnly = false;
  let showDiff = false;
  let applyPatches = false;
  let dryRun = false;
  let force = false;
  let explicitTag = '';
  let squadName = '';
  let targetDir = '.';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--check') checkOnly = true;
    else if (arg === '--diff') showDiff = true;
    else if (arg === '--apply-patches') applyPatches = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--force') force = true;
    else if (arg === '--to' && args[i + 1]) explicitTag = args[++i];
    else if (arg.startsWith('--to=')) explicitTag = arg.slice('--to='.length);
    else if (arg === '--squad' && args[i + 1]) squadName = args[++i];
    else if (arg.startsWith('--squad=')) squadName = arg.slice('--squad='.length);
    else if (!arg.startsWith('-')) targetDir = arg;
  }

  const targetRoot = path.resolve(process.cwd(), targetDir);
  if (squadName) {
    squadName = assertSafeSquadName(squadName);
  }
  if (showDiff) {
    process.exit(runDiffPatches(targetRoot));
  }
  if (applyPatches) {
    process.exit(runApplyPatches(targetRoot, { dryRun, force }));
  }

  if (isEnterpriseOfflineMode()) {
    console.error(
      '❌ Security Policy: Remote framework upgrade is blocked when CORTEX_OFFLINE=1 or CORTEX_NO_NETWORK=1. Use a pre-installed internal registry package (`npx --no-install cortex sync`).'
    );
    process.exit(1);
  }

  const repoSlug = resolveUpgradeRepoSlug();
  const current = resolveInstalledVersion(targetRoot);

  let targetTag = '';
  if (explicitTag) {
    if (!SEMVER_TAG_RE.test(explicitTag)) {
      console.error(`❌ Invalid release tag '${explicitTag}'. Expected semver tag like v0.9.1.`);
      process.exit(1);
    }
    targetTag = explicitTag.startsWith('v') ? explicitTag : `v${explicitTag}`;
  } else {
    console.log(`🔎 Checking latest release for ${repoSlug}...`);
    targetTag = (await fetchLatestReleaseTag(repoSlug)) || '';
    if (!targetTag) {
      console.error(
        `❌ Could not resolve latest release tag from GitHub (offline or rate-limited). Pass '--to <tag>' explicitly or run 'npx --yes github:${repoSlug}#v0.47.1 sync'.`
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
      console.log(`   Run: npx --yes github:${repoSlug}#${targetTag} sync ${targetDir === '.' ? '' : targetDir}`.trim());
    } else {
      console.log(`\n✅ Already up to date (${current.version}).`);
    }
    process.exit(0);
  }

  const syncFlags = ['--yes', `github:${repoSlug}#${targetTag}`, 'sync', targetRoot];
  if (dryRun) syncFlags.push('--dry-run');
  if (force) syncFlags.push('--force');
  if (squadName) syncFlags.push('--squad', squadName);

  if (/[&|<>^%!"'`()\t\r\n;$]/.test(targetRoot)) {
    console.error(
      `❌ Security Error: Target directory '${targetRoot}' contains disallowed shell metacharacters.`
    );
    process.exit(1);
  }

  console.log(`\n⚡ Running: npx ${syncFlags.join(' ')}\n`);
  const npxCliCandidate = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npx-cli.js'
  );
  const res = fs.existsSync(npxCliCandidate)
    ? spawnSync(process.execPath, [npxCliCandidate, ...syncFlags], {
        stdio: 'pipe',
        encoding: 'utf8',
        shell: false,
      })
    : spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', syncFlags, {
        stdio: 'pipe',
        encoding: 'utf8',
        shell: process.platform === 'win32',
      });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.status !== 0 && isEallowgitError(`${res.stderr || ''}\n${res.stdout || ''}`)) {
    console.warn(
      `\n⚠️  npm blocked git-type fetches (EALLOWGIT). Falling back to HTTPS release tarball / shallow git clone for ${targetTag}...\n`
    );
    const fallbackStatus = await runTarballOrCloneSync({
      repoSlug,
      targetTag,
      targetRoot,
      dryRun,
      force,
      squadName,
    });
    process.exit(fallbackStatus);
  }
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.error) {
    console.error(`❌ Failed to invoke npx: ${res.error.message}`);
    process.exit(1);
  }
  process.exit(res.status ?? 1);
}

const isDirectExecution =
  Boolean(process.argv[1]) &&
  (() => {
    try {
      return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
    } catch {
      return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
    }
  })();
if (isDirectExecution) {
  main().catch((err) => {
    console.error(`❌ Upgrade failed: ${err?.message || err}`);
    process.exit(1);
  });
}
