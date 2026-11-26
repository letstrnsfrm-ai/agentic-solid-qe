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
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_REPO_SLUG = 'letstrnsfrm-ai/agentic-solid-qe';
const SAFE_REPO_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const SAFE_SQUAD_NAME_RE = /^[a-z0-9][a-z0-9-]*$/i;
const SEMVER_TAG_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const MAX_TARBALL_BYTES = 50 * 1024 * 1024; // 50 MB compressed download cap
const MAX_TARBALL_UNCOMPRESSED_BYTES = 150 * 1024 * 1024; // 150 MB uncompressed cap (anti-gzip-bomb)
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
  // A custom repo redirects the upgrade to code from an arbitrary owner.
  // Only honour it when the operator explicitly opts in; otherwise the
  // upgrade always comes from the official repository.
  const optIn = String(env.CORTEX_UPGRADE_ALLOW_CUSTOM_REPO || '').trim().toLowerCase();
  if (optIn !== '1' && optIn !== 'true') {
    throw new Error(
      `Security Error: CORTEX_UPGRADE_REPO '${custom}' is not the official repository '${DEFAULT_REPO_SLUG}'. ` +
        `Set CORTEX_UPGRADE_ALLOW_CUSTOM_REPO=1 to explicitly opt in to upgrading from a custom repository.`
    );
  }
  return custom;
}

/**
 * Resolves a release tag to the full commit SHA it points at, via
 * `git ls-remote --tags`. Prefers the peeled `^{}` ref (annotated tags point
 * at a tag object, not the commit); for lightweight tags the tag ref itself
 * is the commit. Throws a Security Error when the tag cannot be resolved —
 * an upgrade must never execute code it cannot pin to a commit.
 */
export function resolveTagCommitSha(repoSlug, targetTag) {
  const slug = String(repoSlug || '').trim();
  const tag = String(targetTag || '').trim();
  if (!SAFE_REPO_SLUG_RE.test(slug) || !tag || tag.includes('..') || /[\s'"]/.test(tag)) {
    throw new Error(`Security Error: Cannot resolve commit for tag '${tag}' in '${slug}'.`);
  }
  const url = `https://github.com/${slug}.git`;
  let res;
  try {
    res = spawnSync('git', ['ls-remote', '--tags', url], { encoding: 'utf8', timeout: 15000 });
  } catch (err) {
    throw new Error(`Security Error: Failed to resolve tag '${tag}' for '${slug}': ${err?.message || err}.`);
  }
  if (res.status !== 0 || !res.stdout) {
    throw new Error(
      `Security Error: Failed to resolve tag '${tag}' for '${slug}': ${String(res.stderr || res.error || 'git ls-remote failed').trim()}.`
    );
  }
  const wanted = `refs/tags/${tag}`;
  let fallback = null;
  for (const line of String(res.stdout).split('\n')) {
    const [sha, ref] = line.split('\t');
    if (!sha || !ref) continue;
    if (ref === `${wanted}^{}` && /^[0-9a-f]{40}$/i.test(sha)) return sha.toLowerCase();
    if (ref === wanted && /^[0-9a-f]{40}$/i.test(sha)) fallback = sha.toLowerCase();
  }
  if (fallback) return fallback;
  throw new Error(`Security Error: Tag '${tag}' was not found in '${slug}'. Refusing to upgrade from an unverifiable tag.`);
}

/**
 * Reads the commit SHA embedded in a GitHub codeload tarball's pax global
 * header (`comment=<sha>`). Returns the lowercase 40-hex SHA, or null when
 * the tarball carries no verifiable commit id. Runs after validateTarBuffer,
 * so header sizes are already known to be well-formed.
 */
export function extractTarballCommitSha(tarBuf) {
  if (!Buffer.isBuffer(tarBuf)) return null;
  let offset = 0;
  while (offset + 512 <= tarBuf.byteLength) {
    const header = tarBuf.subarray(offset, offset + 512);
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) {
      offset += 512;
      continue;
    }
    const typeFlagByte = header[156];
    const typeFlag = typeFlagByte === 0 ? '0' : String.fromCharCode(typeFlagByte);
    let headerSize;
    try {
      headerSize = parseTarOctalOrBase256Size(header, 124, 12);
    } catch {
      return null;
    }
    const dataStart = offset + 512;
    if (typeFlag === 'g') {
      const paxText = tarBuf.subarray(dataStart, dataStart + headerSize).toString('utf8');
      for (const line of paxText.split('\n')) {
        const spIdx = line.indexOf(' ');
        const eqIdx = line.indexOf('=', spIdx + 1);
        if (spIdx === -1 || eqIdx === -1) continue;
        if (line.slice(spIdx + 1, eqIdx) === 'comment') {
          const val = line.slice(eqIdx + 1).trim();
          if (/^[0-9a-f]{40}$/i.test(val)) return val.toLowerCase();
        }
      }
    }
    offset = dataStart + Math.ceil(headerSize / 512) * 512;
  }
  return null;
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
  'scripts/system-map-reporter.mjs',
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

// Framework scripts that execute the upgrade/sync itself. A local patch must
// never overwrite these, even with --force: a planted patch would persist
// into every later upgrade/sync. They are only updated by a verified release
// (tarball/clone/npx pinned to a commit SHA).
const PROTECTED_PATCH_TARGETS = new Set([
  'scripts/sync-skills.mjs',
  'scripts/upgrade-framework.mjs',
  'scripts/orchestrate.mjs',
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
    // A patch must never overwrite the CLI/upgrade scripts themselves, even
    // with --force — a planted patch would persist into every later
    // upgrade/sync. Those files are only updated by a verified release.
    // The patch is kept for manual review; it is not deleted.
    if (PROTECTED_PATCH_TARGETS.has(p.targetRel)) {
      remaining++;
      console.log(
        `🛑 Refused to apply patch to protected framework script ${p.targetRel}: upgrade the CLI via a verified release instead (patch kept at ${p.patchRel} for manual review).`
      );
      continue;
    }
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
          try {
            fs.chmodSync(backupPath, 0o600);
          } catch {}
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
    const entry = String(rawEntry ?? '');
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (
      entry.includes('\0') ||
      /[\r\n]/.test(entry) ||
      trimmed.startsWith('/') ||
      trimmed.startsWith('\\') ||
      trimmed.startsWith('-') ||
      /^[A-Za-z]:/.test(trimmed) ||
      /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(trimmed)
    ) {
      throw new Error(`Security Error: Unsafe archive entry '${trimmed}' detected (Zip-Slip protection).`);
    }
  }
  return true;
}

function readNullTerminatedAscii(buf, start, length) {
  const slice = buf.subarray(start, start + length);
  const nulIdx = slice.indexOf(0);
  return (nulIdx === -1 ? slice : slice.subarray(0, nulIdx)).toString('utf8');
}

function parseTarOctalOrBase256Size(buf, start, length) {
  if ((buf[start] & 0x80) !== 0) {
    let val = 0n;
    for (let i = 1; i < length; i++) {
      val = (val << 8n) | BigInt(buf[start + i]);
    }
    if (val < 0n || val > BigInt(MAX_TARBALL_UNCOMPRESSED_BYTES)) {
      throw new Error('Security Error: Unsafe archive member size in binary tar header.');
    }
    return Number(val);
  }
  const raw = readNullTerminatedAscii(buf, start, length).trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) {
    throw new Error(`Security Error: Malformed octal size '${raw}' in tar header.`);
  }
  const parsed = parseInt(raw, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_TARBALL_UNCOMPRESSED_BYTES) {
    throw new Error('Security Error: Tar member exceeds uncompressed size safety limit.');
  }
  return parsed;
}

/**
 * Inspects uncompressed POSIX USTAR / PAX / GNU tar headers directly in memory.
 * Rejects symlinks ('2'), hardlinks ('1'), character/block devices ('3'/'4'), FIFOs ('6'),
 * non-empty linkname fields, PAX linkpath overrides, and Zip-Slip path traversal entries.
 */
export function validateTarBuffer(tarBuf) {
  if (!Buffer.isBuffer(tarBuf)) {
    throw new Error('Security Error: Expected tar Buffer.');
  }
  if (tarBuf.byteLength > MAX_TARBALL_UNCOMPRESSED_BYTES) {
    throw new Error(`Security Error: Uncompressed archive exceeds ${MAX_TARBALL_UNCOMPRESSED_BYTES}-byte safety limit.`);
  }
  const entries = [];
  let offset = 0;
  let paxSizeOverride = null;
  while (offset + 512 <= tarBuf.byteLength) {
    const header = tarBuf.subarray(offset, offset + 512);
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) {
      offset += 512;
      continue;
    }
    const name = readNullTerminatedAscii(header, 0, 100);
    const prefix = readNullTerminatedAscii(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const typeFlagByte = header[156];
    const typeFlag = typeFlagByte === 0 ? '0' : String.fromCharCode(typeFlagByte);
    const linkName = readNullTerminatedAscii(header, 157, 100);
    const headerSize = parseTarOctalOrBase256Size(header, 124, 12);
    const memberSize = paxSizeOverride !== null ? paxSizeOverride : headerSize;
    paxSizeOverride = null;

    if (linkName) {
      throw new Error(
        `Security Error: Symbolic or hard link target '${linkName}' in archive entry '${fullName}' is forbidden.`
      );
    }
    // Allowed tar typeflags: '0' (file), '5' (directory), 'x'/'g' (PAX header), 'L' (GNU longname)
    if (typeFlag !== '0' && typeFlag !== '5' && typeFlag !== 'x' && typeFlag !== 'g' && typeFlag !== 'L') {
      throw new Error(
        `Security Error: Disallowed tar entry type '${typeFlag}' for '${fullName}' (symlinks, hardlinks, and special files are forbidden).`
      );
    }

    const dataStart = offset + 512;
    const dataEnd = dataStart + memberSize;
    if (dataEnd > tarBuf.byteLength) {
      throw new Error('Security Error: Truncated or malformed tar archive stream.');
    }

    if (typeFlag === 'x' || typeFlag === 'g') {
      const paxText = tarBuf.subarray(dataStart, dataEnd).toString('utf8');
      for (const line of paxText.split('\n')) {
        if (!line) continue;
        const eqIdx = line.indexOf('=');
        const spIdx = line.indexOf(' ');
        if (spIdx === -1 || eqIdx === -1 || eqIdx < spIdx) continue;
        const key = line.slice(spIdx + 1, eqIdx);
        const val = line.slice(eqIdx + 1);
        if (key === 'linkpath' && val) {
          throw new Error(`Security Error: PAX linkpath '${val}' is forbidden in release tarball.`);
        }
        if (key === 'path') {
          validateTarArchiveEntries([val]);
          entries.push(val);
        }
        if (key === 'size' && /^\d+$/.test(val)) {
          const pSize = Number(val);
          if (!Number.isSafeInteger(pSize) || pSize > MAX_TARBALL_UNCOMPRESSED_BYTES) {
            throw new Error('Security Error: PAX size exceeds uncompressed safety limit.');
          }
          paxSizeOverride = pSize;
        }
      }
    } else if (typeFlag === 'L') {
      const longName = readNullTerminatedAscii(tarBuf, dataStart, memberSize);
      validateTarArchiveEntries([longName]);
      entries.push(longName);
    } else if (fullName && fullName !== 'pax_global_header') {
      validateTarArchiveEntries([fullName]);
      entries.push(fullName);
    }

    const paddedBlocks = Math.ceil(memberSize / 512) * 512;
    offset = dataStart + paddedBlocks;
  }
  return entries;
}

function assertExtractedTreeSafe(rootDir) {
  const stack = [rootDir];
  while (stack.length > 0) {
    const cur = stack.pop();
    const entries = fs.readdirSync(cur, { withFileTypes: true });
    for (const d of entries) {
      const full = path.join(cur, d.name);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) {
        throw new Error(`Security Error: Extracted release archive contains symbolic link '${d.name}'.`);
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile()) {
        if (process.platform !== 'win32' && st.nlink > 1) {
          throw new Error(`Security Error: Extracted release archive contains hardlink '${d.name}'.`);
        }
      } else {
        throw new Error(`Security Error: Extracted release archive contains special non-file entry '${d.name}'.`);
      }
    }
  }
}

function resolveSafeNpxCliJs() {
  const candidates = [];
  if (process.env.npm_execpath) {
    candidates.push(path.join(path.dirname(process.env.npm_execpath), 'npx-cli.js'));
  }
  const nodeDir = path.dirname(process.execPath);
  candidates.push(
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js')
  );
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && !fs.lstatSync(c).isSymbolicLink()) return c;
    } catch {}
  }
  return null;
}

export async function runTarballOrCloneSync({
  repoSlug,
  targetTag,
  targetRoot,
  dryRun = false,
  force = false,
  squadName = '',
  expectedSha = '',
} = {}) {
  // Pin the release to a commit before executing anything from it. Callers
  // that already resolved the tag (main()) pass it in; otherwise resolve here.
  const verifiedSha = String(expectedSha || '').trim().toLowerCase() || resolveTagCommitSha(repoSlug, targetTag);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asqe-upgrade-'));
  try {
    fs.chmodSync(tmpDir, 0o700);
  } catch {}
  try {
    let extractedDir = null;
    const tarballUrl = buildReleaseTarballUrl(repoSlug, targetTag);
    const uncompressedTarPath = path.join(tmpDir, 'release.tar');
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
        let tarBuf;
        try {
          tarBuf = zlib.gunzipSync(buf, { maxOutputLength: MAX_TARBALL_UNCOMPRESSED_BYTES });
        } catch (zErr) {
          if (zErr?.code === 'ERR_BUFFER_TOO_LARGE') {
            throw new Error(
              `Security Error: Uncompressed release tarball exceeds ${MAX_TARBALL_UNCOMPRESSED_BYTES}-byte decompression bomb limit.`
            );
          }
          throw zErr;
        }
        validateTarBuffer(tarBuf);
        // Verify the payload before executing anything from it: the tarball
        // must carry the commit the tag resolves to. A missing or mismatched
        // id is refused — the verified shallow clone below is the fallback.
        const tarSha = extractTarballCommitSha(tarBuf);
        if (tarSha !== verifiedSha) {
          console.warn(
            `⚠️  Release tarball for '${targetTag}' did not carry the expected commit ${verifiedSha}; falling back to a verified shallow clone.`
          );
        } else {
        fs.writeFileSync(uncompressedTarPath, tarBuf, { mode: 0o600 });
        const extractDir = path.join(tmpDir, 'extracted');
        fs.mkdirSync(extractDir, { recursive: true, mode: 0o700 });
        const tarRes = spawnSync(
          'tar',
          ['-xf', uncompressedTarPath, '-C', extractDir, '--no-same-owner', '--no-same-permissions'],
          {
            stdio: 'pipe',
            encoding: 'utf8',
            shell: false,
          }
        );
        if (tarRes.status === 0) {
          assertExtractedTreeSafe(extractDir);
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
        [
          '-c',
          'core.symlinks=false',
          'clone',
          '--branch',
          targetTag,
          '--depth',
          '1',
          '--',
          `https://github.com/${repoSlug}.git`,
          cloneDir,
        ],
        { stdio: 'inherit', shell: false }
      );
      if (cloneRes.status !== 0) {
        return cloneRes.status ?? 1;
      }
      // Verify the clone is the commit the tag resolves to before executing
      // anything from it (a moved tag would otherwise land here unverified).
      const headRes = spawnSync('git', ['-C', cloneDir, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        shell: false,
      });
      const clonedSha = String(headRes.stdout || '').trim().toLowerCase();
      if (headRes.status !== 0 || clonedSha !== verifiedSha) {
        throw new Error(
          `Security Error: Cloned release '${targetTag}' resolved to commit '${clonedSha || 'unknown'}', not the expected ${verifiedSha}. Refusing to execute it.`
        );
      }
      assertExtractedTreeSafe(cloneDir);
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
        `❌ Could not resolve latest release tag from GitHub (offline or rate-limited). Pass '--to <tag>' explicitly or run 'npx cortex upgrade --to v0.48.18'.`
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
      console.log(`   Run: npx cortex upgrade --to ${targetTag} ${targetDir === '.' ? '' : targetDir}`.trim());
    } else {
      console.log(`\n✅ Already up to date (${current.version}).`);
    }
    process.exit(0);
  }

  // Pin the release to the commit the tag resolves to BEFORE executing
  // anything: a tag can be moved after it is read, so the npx spec uses the
  // full commit SHA instead of the tag. The tarball/clone fallback below is
  // verified against the same SHA.
  const expectedSha = resolveTagCommitSha(repoSlug, targetTag);
  console.log(`\n🔒 Target release: ${targetTag} (commit ${expectedSha})\n`);

  const syncFlags = ['--yes', `github:${repoSlug}#${expectedSha}`, 'sync', targetRoot];
  if (dryRun) syncFlags.push('--dry-run');
  if (force) syncFlags.push('--force');
  if (squadName) syncFlags.push('--squad', squadName);

  if (/[&|<>^%!"'`()\t\r\n;$]/.test(targetRoot) || path.basename(targetRoot).startsWith('-')) {
    console.error(
      `❌ Security Error: Target directory '${targetRoot}' contains disallowed shell/flag metacharacters.`
    );
    process.exit(1);
  }

  const npxCliJs = resolveSafeNpxCliJs();
  // Never spawn npx.cmd with shell: true on Windows (CVE-2024-24576 / argument-splitting injection);
  // when npx-cli.js cannot be resolved directly on Windows, use verified HTTPS tarball/clone sync directly.
  if (!npxCliJs && process.platform === 'win32') {
    const fallbackStatus = await runTarballOrCloneSync({
      repoSlug,
      targetTag,
      targetRoot,
      dryRun,
      force,
      squadName,
      expectedSha,
    });
    process.exit(fallbackStatus);
  }

  console.log(`\n⚡ Running: npx ${syncFlags.join(' ')}\n`);
  const res = npxCliJs
    ? spawnSync(process.execPath, [npxCliJs, ...syncFlags], {
        stdio: 'pipe',
        encoding: 'utf8',
        shell: false,
      })
    : spawnSync('npx', syncFlags, {
        stdio: 'pipe',
        encoding: 'utf8',
        shell: false,
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
      expectedSha,
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
