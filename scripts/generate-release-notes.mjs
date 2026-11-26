#!/usr/bin/env node
/**
 * Automated Semantic Versioning & Rich Release Notes Generator for Agentic-SOLID-QE.
 *
 * Inspects git history since the latest `v*` tag (falling back to `package.json` version
 * as the baseline when no tags exist), computes the next SemVer version based on
 * Conventional Commits, and generates a structured Markdown release report showcasing
 * categorized commits and an architectural breakdown of what changed in the repository.
 *
 * Usage:
 *   node scripts/generate-release-notes.mjs --dry-run
 *   node scripts/generate-release-notes.mjs --output .release-notes.md --json-meta .release-meta.json
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (allowFailure) return '';
    throw error;
  }
}

function parseSemver(versionString) {
  const cleaned = String(versionString || '').trim().replace(/^v/, '');
  const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return { major: 0, minor: 2, patch: 0 };
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function formatSemver({ major, minor, patch }) {
  return `v${major}.${minor}.${patch}`;
}

function bumpSemver(base, bumpType) {
  if (bumpType === 'major') {
    return { major: base.major + 1, minor: 0, patch: 0 };
  }
  if (bumpType === 'minor') {
    return { major: base.major, minor: base.minor + 1, patch: 0 };
  }
  return { major: base.major, minor: base.minor, patch: base.patch + 1 };
}

function detectRepoSlug() {
  const safeSlugRegex = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
  if (process.env.GITHUB_REPOSITORY && safeSlugRegex.test(process.env.GITHUB_REPOSITORY.trim())) {
    return process.env.GITHUB_REPOSITORY.trim();
  }
  const remoteUrl = git(['config', '--get', 'remote.origin.url'], { allowFailure: true });
  const match = remoteUrl.match(/github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/);
  return match && safeSlugRegex.test(match[1]) ? match[1] : 'letstrnsfrm-ai/agentic-solid-qe';
}

function getLatestVersionTag() {
  const tagsRaw = git(['tag', '--list', 'v*', '--sort=-v:refname'], { allowFailure: true });
  if (!tagsRaw) return null;
  const tags = tagsRaw
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
  return tags[0] || null;
}

function getHeadVersionTags() {
  const tagsRaw = git(['tag', '--points-at', 'HEAD', 'v*'], { allowFailure: true });
  if (!tagsRaw) return [];
  return tagsRaw
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
}

function parseCommits(rangeSpec) {
  const format = '%H%x1f%h%x1f%s%x1f%b%x1f%an%x1e';
  const logArgs = rangeSpec ? ['log', rangeSpec, `--format=${format}`] : ['log', `--format=${format}`];
  const raw = git(logArgs, { allowFailure: true });
  if (!raw) return [];

  return raw
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [hash, shortHash, subject, body = '', author = ''] = entry.split('\x1f');
      const conventionalMatch = subject.match(/^([a-zA-Z]+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);
      const type = conventionalMatch ? conventionalMatch[1].toLowerCase() : 'other';
      const scope = conventionalMatch && conventionalMatch[2] ? conventionalMatch[2] : null;
      const isBreaking =
        Boolean(conventionalMatch && conventionalMatch[3] === '!') ||
        /^BREAKING[ -]CHANGE:\s/m.test(body);
      const description = conventionalMatch ? conventionalMatch[4].trim() : subject.trim();

      return {
        hash,
        shortHash,
        subject: subject.trim(),
        body: body.trim(),
        author: author.trim(),
        type,
        scope,
        isBreaking,
        description,
      };
    });
}

function determineBumpType(commits) {
  let bump = 'patch';
  for (const commit of commits) {
    if (commit.isBreaking) return 'major';
    if (commit.type === 'feat') bump = 'minor';
  }
  return bump;
}

function classifyFileArea(filePath) {
  if (
    filePath.startsWith('.agents/skills/') ||
    filePath.startsWith('.github/prompts/') ||
    filePath.startsWith('.claude/commands/') ||
    filePath === 'AGENTS.md' ||
    filePath === '.github/copilot-instructions.md'
  ) {
    return 'skills';
  }
  if (filePath.startsWith('.agents/domain/')) {
    return 'domain';
  }
  if (filePath.startsWith('.exploratory/') || filePath.startsWith('defects/')) {
    return 'exploratory';
  }
  if (filePath.startsWith('src/') || filePath.startsWith('tests/')) {
    return 'solid';
  }
  if (
    filePath.startsWith('scripts/') ||
    filePath.startsWith('.github/workflows/') ||
    filePath === 'package.json' ||
    filePath === 'package-lock.json'
  ) {
    return 'tooling';
  }
  return 'docs';
}

function getDiffBreakdown(baseRef, headRef = 'HEAD') {
  const diffArgs = baseRef
    ? ['diff', '--name-status', `${baseRef}..${headRef}`]
    : ['show', '--name-status', '--format=', headRef];
  const numstatArgs = baseRef
    ? ['diff', '--numstat', `${baseRef}..${headRef}`]
    : ['show', '--numstat', '--format=', headRef];

  const statusRaw = git(diffArgs, { allowFailure: true });
  const numstatRaw = git(numstatArgs, { allowFailure: true });

  const statsByFile = new Map();
  let totalInsertions = 0;
  let totalDeletions = 0;

  for (const line of numstatRaw.split('\n').filter(Boolean)) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const added = parts[0] === '-' ? 0 : Number(parts[0]) || 0;
    const deleted = parts[1] === '-' ? 0 : Number(parts[1]) || 0;
    const rawPath = parts.slice(2).join('\t').trim();
    const normalizedPath = rawPath
      .replace(/\{[^{}]*? => ([^{}]*?)\}/g, '$1')
      .replace(/^.* => /, '')
      .replace(/\/+/g, '/')
      .replace(/^\/+/, '');
    totalInsertions += added;
    totalDeletions += deleted;
    statsByFile.set(normalizedPath, { added, deleted });
  }

  const files = [];
  for (const line of statusRaw.split('\n').filter(Boolean)) {
    const parts = line.split('\t');
    const statusCode = parts[0].charAt(0);
    const filePath = (parts[parts.length - 1] || '').trim();
    if (!filePath) continue;
    const stat = statsByFile.get(filePath) || { added: 0, deleted: 0 };
    files.push({
      status: statusCode,
      path: filePath,
      area: classifyFileArea(filePath),
      added: stat.added,
      deleted: stat.deleted,
    });
  }

  return {
    files,
    totalFiles: files.length,
    totalInsertions,
    totalDeletions,
  };
}

function statusBadge(status) {
  switch (status) {
    case 'A':
      return '🟢 Added';
    case 'M':
      return '🔵 Modified';
    case 'D':
      return '🔴 Deleted';
    case 'R':
      return '🟣 Renamed';
    default:
      return `⚪ ${status}`;
  }
}

export function sanitizeReleaseCommitText(val) {
  return String(val ?? '')
    .replace(/[\x00-\x1f\x7f\u202A-\u202E\u2066-\u2069\r\n]+/g, ' ')
    // Escape backslashes FIRST: a pre-escaped payload such as `\[spoof\](url)`
    // otherwise survives as `\\[spoof\\](url)`, which Markdown collapses back
    // into a live link. Doubling the backslash first keeps every later escape literal.
    .replace(/\\/g, '\\\\')
    .replace(/([|`<>\[\]()!*_])/g, '\\$1')
    // Neutralise @mentions so a crafted subject/scope cannot ping users from
    // the official release body (same treatment the author field already gets).
    .replace(/@/g, '@\u200B')
    .trim();
}

function generateMarkdown({
  repoSlug,
  previousTag,
  nextTag,
  bumpType,
  commits,
  diff,
  compareBaseRef,
}) {
  const headlineCommit = commits[0];
  const cleanHeadline = headlineCommit
    ? String(headlineCommit.subject || '')
        .replace(/[\x00-\x1f\x7f\u202A-\u202E\u2066-\u2069\r\n]+/g, ' ')
        // Plain-text title (also passed to `gh release create --title`): do not
        // Markdown-escape it, or every scoped subject would show backslashes.
        // Instead break link/image formation and neutralise @mentions.
        .replace(/@/g, '@\u200B')
        .replace(/([\[!])/g, '$1\u200B')
        .trim()
    : '';
  const releaseTitle = cleanHeadline
    ? `${nextTag} — ${cleanHeadline}`
    : `${nextTag}`;

  const sections = [];
  sections.push(`## What's Changed in \`${nextTag}\``);
  sections.push('');
  sections.push(
    `> **Release Type:** \`${bumpType.toUpperCase()}\` · **Commits:** \`${commits.length}\` · **Files Touched:** \`${diff.totalFiles}\` (\`+${diff.totalInsertions}\` / \`-${diff.totalDeletions}\` lines)`
  );
  sections.push('');

  // 1. Categorized Commits
  const commitGroups = [
    {
      key: 'breaking',
      title: '### ⚠️ Breaking Changes',
      filter: (c) => c.isBreaking,
    },
    {
      key: 'feat',
      title: '### 🚀 Features & Capabilities',
      filter: (c) => !c.isBreaking && c.type === 'feat',
    },
    {
      key: 'fix',
      title: '### 🐛 Bug Fixes & Healing',
      filter: (c) => !c.isBreaking && (c.type === 'fix' || c.type === 'perf'),
    },
    {
      key: 'refactor',
      title: '### 🏗️ Architecture & Refactoring',
      filter: (c) => !c.isBreaking && (c.type === 'refactor' || c.type === 'test'),
    },
    {
      key: 'docs',
      title: '### 📚 Documentation, Skills & Maintenance',
      filter: (c) =>
        !c.isBreaking &&
        !['feat', 'fix', 'perf', 'refactor', 'test'].includes(c.type),
    },
  ];

  for (const group of commitGroups) {
    const matching = commits.filter(group.filter);
    if (matching.length === 0) continue;
    sections.push(group.title);
    sections.push('');
    const escapeMdInline = sanitizeReleaseCommitText;
    for (const commit of matching) {
      const scopePrefix = commit.scope ? `**${escapeMdInline(commit.scope)}:** ` : '';
      const commitUrl = `https://github.com/${repoSlug}/commit/${commit.hash}`;
      const safeAuthor = commit.author ? escapeMdInline(commit.author) : '';
      const authorSuffix = safeAuthor ? ` by **${safeAuthor}**` : '';
      sections.push(
        `- ${scopePrefix}${escapeMdInline(commit.description)} ([\`${commit.shortHash}\`](${commitUrl}))${authorSuffix}`
      );
    }
    sections.push('');
  }

  // 2. Architectural Repo Change Breakdown
  const areaDefinitions = [
    {
      id: 'skills',
      label: '🤖 Agent Skills & Slash Prompts',
    },
    {
      id: 'domain',
      label: '🧠 Domain Memory & Feature Shards',
    },
    {
      id: 'exploratory',
      label: '📼 Exploratory Session Tapes & Defects',
    },
    {
      id: 'solid',
      label: '🏗️ SOLID Components, Pages, Fixtures & Specs',
    },
    {
      id: 'tooling',
      label: '⚙️ CLI, Automation Scripts & CI Pipelines',
    },
    {
      id: 'docs',
      label: '📄 Documentation & Project Configuration',
    },
  ];

  const sanitizePathCode = (p) =>
    String(p ?? '')
      .replace(/[\u202A-\u202E\u2066-\u2069\r\n`|<>]/g, '')
      .trim();

  if (diff.files.length > 0) {
    sections.push('### 📦 Repository Impact Breakdown');
    sections.push('');
    sections.push('| Architectural Layer | Files Changed | Line Delta | Key Paths |');
    sections.push('| :--- | :---: | :---: | :--- |');

    for (const area of areaDefinitions) {
      const areaFiles = diff.files.filter((f) => f.area === area.id);
      if (areaFiles.length === 0) continue;
      const added = areaFiles.reduce((sum, f) => sum + f.added, 0);
      const deleted = areaFiles.reduce((sum, f) => sum + f.deleted, 0);
      const samplePaths = areaFiles
        .slice(0, 3)
        .map((f) => `\`${sanitizePathCode(f.path)}\``)
        .join(', ');
      const extraCount = areaFiles.length > 3 ? ` _(+${areaFiles.length - 3} more)_` : '';
      sections.push(
        `| ${area.label} | ${areaFiles.length} | \`+${added}\` / \`-${deleted}\` | ${samplePaths}${extraCount} |`
      );
    }
    sections.push('');

    sections.push('<details>');
    sections.push(`<summary>🔍 View all ${diff.files.length} changed file(s)</summary>`);
    sections.push('');
    sections.push('| Status | File Path | Delta |');
    sections.push('| :--- | :--- | :---: |');
    for (const file of diff.files) {
      sections.push(
        `| ${statusBadge(file.status)} | \`${sanitizePathCode(file.path)}\` | \`+${file.added}\` / \`-${file.deleted}\` |`
      );
    }
    sections.push('');
    sections.push('</details>');
    sections.push('');
  }

  // 3. Consumer Upgrade & Diff Links
  sections.push('### ⚡ Upgrade Existing Projects');
  sections.push('');
  sections.push('```bash');
  sections.push('npm run upgrade:skills');
  sections.push('# or pin to this release tag explicitly:');
  sections.push(`npx cortex upgrade --to ${nextTag}`);
  sections.push('```');
  sections.push('');

  if (previousTag) {
    sections.push(
      `**Full Changelog:** [\`${previousTag}...${nextTag}\`](https://github.com/${repoSlug}/compare/${previousTag}...${nextTag})`
    );
  } else if (compareBaseRef) {
    sections.push(
      `**Full Changelog:** [\`${compareBaseRef.slice(0, 7)}...${nextTag}\`](https://github.com/${repoSlug}/compare/${compareBaseRef}...${nextTag})`
    );
  }

  return {
    releaseTitle,
    markdown: sections.join('\n').trim() + '\n',
  };
}

function assertValidSha(sha, sourceLabel) {
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    console.error(`❌ Invalid git commit SHA from ${sourceLabel}: '${sha}'. Expected 40-character hex SHA.`);
    process.exit(1);
  }
  return sha;
}

export function resolveSafeRepoOutputPath(targetPath, flagName, rootDir = ROOT) {
  const resolvedRoot = path.resolve(rootDir);
  const resolved = path.resolve(resolvedRoot, targetPath);
  const relToRoot = path.relative(resolvedRoot, resolved).replace(/\\/g, '/');
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
    throw new Error(
      `Invalid ${flagName} path '${targetPath}'. Output path must reside within the repository root.`
    );
  }
  if (relToRoot === '.git' || relToRoot.startsWith('.git/')) {
    throw new Error(`Security Error: Refusing to write ${flagName} inside '.git/'.`);
  }
  let cur = resolved;
  while (cur !== resolvedRoot) {
    try {
      if (fs.lstatSync(cur).isSymbolicLink()) {
        throw new Error(
          `Security Error: Refusing to write ${flagName} to symbolic link '${cur === resolved ? targetPath : path.relative(resolvedRoot, cur)}'.`
        );
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
    let existing = resolved;
    while (!fs.existsSync(existing) && existing !== resolvedRoot) {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
    const realExisting = fs.realpathSync(existing);
    const realRel = path.relative(realRoot, realExisting);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw new Error(
        `Security Error: Output realpath escapes repository root for ${flagName}: '${targetPath}'.`
      );
    }
  }
  return resolved;
}

export function syncReleaseManifests(rootDir, { version, date = null, highlights = [] } = {}) {
  const cleanVersion = String(version || '').trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(cleanVersion)) {
    throw new Error(`Invalid release version '${version}'. Expected SemVer X.Y.Z.`);
  }
  const isoDate = date || new Date().toISOString().slice(0, 10);
  const updatedFiles = [];

  const pkgPath = resolveSafeRepoOutputPath('package.json', 'package.json', rootDir);
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.version !== cleanVersion) {
      pkg.version = cleanVersion;
      fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
      updatedFiles.push('package.json');
    }
  }

  const lockPath = resolveSafeRepoOutputPath('package-lock.json', 'package-lock.json', rootDir);
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    let lockChanged = false;
    if (lock.version !== cleanVersion) {
      lock.version = cleanVersion;
      lockChanged = true;
    }
    if (lock.packages && lock.packages[''] && lock.packages[''].version !== cleanVersion) {
      lock.packages[''].version = cleanVersion;
      lockChanged = true;
    }
    if (lockChanged) {
      fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
      updatedFiles.push('package-lock.json');
    }
  }

  const changelogPath = resolveSafeRepoOutputPath('CHANGELOG.json', 'CHANGELOG.json', rootDir);
  if (fs.existsSync(changelogPath)) {
    const changelog = JSON.parse(fs.readFileSync(changelogPath, 'utf8'));
    let changelogChanged = false;
    if (changelog.latestVersion !== cleanVersion) {
      changelog.latestVersion = cleanVersion;
      changelogChanged = true;
    }
    if (!Array.isArray(changelog.releases)) {
      changelog.releases = [];
    }
    if (changelog.releases[0]?.version !== cleanVersion) {
      const cleanHighlights = (highlights || [])
        .map((h) => sanitizeReleaseCommitText(h))
        .filter(Boolean)
        .slice(0, 5);
      changelog.releases.unshift({
        version: cleanVersion,
        date: isoDate,
        highlights:
          cleanHighlights.length > 0 ? cleanHighlights : [`Automated release v${cleanVersion}.`],
        nextActions: [`Run \`npx cortex upgrade\` to sync v${cleanVersion}.`],
      });
      changelogChanged = true;
    }
    if (changelogChanged) {
      fs.writeFileSync(changelogPath, `${JSON.stringify(changelog, null, 2)}\n`, 'utf8');
      updatedFiles.push('CHANGELOG.json');
    }
  }

  return { version: cleanVersion, updatedFiles };
}

export function checkReleaseManifestSync(rootDir, targetTag) {
  const cleanVersion = String(targetTag || '').trim().replace(/^v/, '');
  const reasons = [];
  if (!/^\d+\.\d+\.\d+$/.test(cleanVersion)) {
    return { ok: false, version: cleanVersion, reasons: [`Invalid target version '${targetTag}'.`] };
  }

  const pkgPath = path.join(rootDir, 'package.json');
  let pkgVersion = null;
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkgVersion = String(pkg.version || '').trim();
    if (pkgVersion !== cleanVersion) {
      reasons.push(`package.json version (${pkgVersion || 'missing'}) !== target tag (${cleanVersion}).`);
    }
  } else {
    reasons.push('package.json not found.');
  }

  const changelogPath = path.join(rootDir, 'CHANGELOG.json');
  let changelogVersion = null;
  if (fs.existsSync(changelogPath)) {
    const changelog = JSON.parse(fs.readFileSync(changelogPath, 'utf8'));
    changelogVersion = String(changelog.latestVersion || '').trim();
    const topRelease = String(changelog?.releases?.[0]?.version || '').trim();
    if (changelogVersion !== cleanVersion) {
      reasons.push(`CHANGELOG.json latestVersion (${changelogVersion || 'missing'}) !== target tag (${cleanVersion}).`);
    }
    if (topRelease !== cleanVersion) {
      reasons.push(`CHANGELOG.json releases[0].version (${topRelease || 'missing'}) !== target tag (${cleanVersion}).`);
    }
  }

  return { ok: reasons.length === 0, version: cleanVersion, pkgVersion, changelogVersion, reasons };
}

function parseCliArgs(argv) {
  const envBefore = process.env.GITHUB_EVENT_BEFORE || null;
  const options = {
    dryRun: false,
    syncManifests: false,
    requireManifestSync: false,
    output: null,
    jsonMeta: null,
    beforeSha: envBefore ? assertValidSha(envBefore, 'GITHUB_EVENT_BEFORE') : null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--sync-manifests') {
      options.syncManifests = true;
    } else if (arg === '--require-manifest-sync') {
      options.requireManifestSync = true;
    } else if (arg === '--output' && argv[i + 1]) {
      options.output = resolveSafeRepoOutputPath(argv[i + 1], '--output');
      i += 1;
    } else if (arg === '--json-meta' && argv[i + 1]) {
      options.jsonMeta = resolveSafeRepoOutputPath(argv[i + 1], '--json-meta');
      i += 1;
    } else if (arg === '--before' && argv[i + 1]) {
      options.beforeSha = assertValidSha(argv[i + 1], '--before');
      i += 1;
    }
  }
  return options;
}

function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const pkgPath = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const pkgSemver = parseSemver(pkg.version || '0.2.0');

  const existingHeadTags = getHeadVersionTags();
  if (existingHeadTags.length > 0 && !options.dryRun) {
    const meta = {
      shouldRelease: false,
      reason: `HEAD is already tagged with ${existingHeadTags.join(', ')}`,
      existingTag: existingHeadTags[0],
    };
    if (options.jsonMeta) {
      fs.mkdirSync(path.dirname(options.jsonMeta), { recursive: true });
      fs.writeFileSync(options.jsonMeta, JSON.stringify(meta, null, 2), 'utf8');
    }
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `should_release=false\n`, 'utf8');
    }
    console.log(`⏭️  Skipping release: ${meta.reason}`);
    return;
  }

  const latestTag = getLatestVersionTag();
  const latestTagSemver = latestTag ? parseSemver(latestTag) : null;

  if (options.requireManifestSync && !options.dryRun) {
    if (latestTagSemver && compareSemver(pkgSemver, latestTagSemver) <= 0) {
      const meta = {
        shouldRelease: false,
        reason: `package.json (${pkg.version}) is not ahead of latest tag ${latestTag}. Bump package.json & CHANGELOG.json in a PR to publish a new release.`,
        existingTag: latestTag,
      };
      if (options.jsonMeta) {
        fs.mkdirSync(path.dirname(options.jsonMeta), { recursive: true });
        fs.writeFileSync(options.jsonMeta, JSON.stringify(meta, null, 2), 'utf8');
      }
      if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `should_release=false\n`, 'utf8');
      }
      console.log(`⏭️  Skipping release: ${meta.reason}`);
      return;
    }
    const targetTag = formatSemver(pkgSemver);
    const syncCheck = checkReleaseManifestSync(ROOT, targetTag);
    if (!syncCheck.ok) {
      throw new Error(
        `Release Version Sync Gate Failed for ${targetTag}:\n  - ${syncCheck.reasons.join('\n  - ')}`
      );
    }
  }

  // Use the higher of package.json version or latest git tag as baseline
  const baseSemver =
    latestTagSemver && compareSemver(latestTagSemver, pkgSemver) >= 0
      ? latestTagSemver
      : pkgSemver;

  // Determine commit range & diff base reference
  let commitRange = '';
  let compareBaseRef = null;
  const zeroSha = '0000000000000000000000000000000000000000';

  if (latestTag) {
    commitRange = `${latestTag}..HEAD`;
    compareBaseRef = latestTag;
  } else if (
    options.beforeSha &&
    options.beforeSha !== zeroSha &&
    git(['cat-file', '-t', options.beforeSha], { allowFailure: true }) === 'commit'
  ) {
    commitRange = `${options.beforeSha}..HEAD`;
    compareBaseRef = options.beforeSha;
  } else {
    // When no tags exist yet and no push `before` SHA is provided, showcase the latest commit on HEAD
    const parentSha = git(['rev-parse', 'HEAD~1'], { allowFailure: true });
    if (parentSha) {
      commitRange = `${parentSha}..HEAD`;
      compareBaseRef = parentSha;
    }
  }

  let commits = parseCommits(commitRange);
  if (commits.length === 0) {
    commits = parseCommits('HEAD~1..HEAD');
  }

  const bumpType = determineBumpType(commits);
  const nextSemver =
    latestTagSemver && compareSemver(pkgSemver, latestTagSemver) > 0
      ? pkgSemver
      : bumpSemver(baseSemver, bumpType);
  const nextTag = formatSemver(nextSemver);
  const repoSlug = detectRepoSlug();
  const diff = getDiffBreakdown(compareBaseRef, 'HEAD');

  const { releaseTitle, markdown } = generateMarkdown({
    repoSlug,
    previousTag: latestTag,
    nextTag,
    bumpType,
    commits,
    diff,
    compareBaseRef,
  });

  if (options.syncManifests && !options.dryRun) {
    const commitHighlights = commits
      .map((c) => String(c.subject || '').trim())
      .filter((s) => s && !/^Merge (pull request|branch)\b/i.test(s));
    const uniqueHighlights = [...new Set(commitHighlights)];
    const syncRes = syncReleaseManifests(ROOT, {
      version: nextTag,
      highlights: uniqueHighlights.length > 0 ? uniqueHighlights : [releaseTitle],
    });
    if (syncRes.updatedFiles.length > 0) {
      console.log(`📦 Synced release manifests for ${nextTag}: ${syncRes.updatedFiles.join(', ')}`);
    }
  }

  if (options.output) {
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, markdown, 'utf8');
  }

  const meta = {
    shouldRelease: true,
    previousTag: latestTag || `v${pkg.version}`,
    nextTag,
    bumpType,
    releaseTitle,
    commitCount: commits.length,
    filesChanged: diff.totalFiles,
  };

  if (options.jsonMeta) {
    fs.mkdirSync(path.dirname(options.jsonMeta), { recursive: true });
    fs.writeFileSync(options.jsonMeta, JSON.stringify(meta, null, 2), 'utf8');
  }

  if (process.env.GITHUB_OUTPUT && !options.dryRun) {
    const delimiter = `GH_EOF_${randomUUID()}`;
    const safeTitle = String(releaseTitle).replace(/\r?\n/g, ' ').trim();
    const outputLines = [
      `should_release=true`,
      `next_tag=${nextTag}`,
      `bump_type=${bumpType}`,
      `release_title<<${delimiter}`,
      safeTitle,
      delimiter,
    ];
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${outputLines.join('\n')}\n`, 'utf8');
  }

  if (process.env.GITHUB_STEP_SUMMARY && !options.dryRun) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`, 'utf8');
  }

  if (options.dryRun || !options.output) {
    console.log(`🏷️  Baseline Version : ${latestTag || `v${pkg.version} (from package.json)`}`);
    console.log(`🚀 Next Release Tag : ${nextTag} (${bumpType} bump)`);
    console.log(`📝 Release Title    : ${releaseTitle}\n`);
    console.log(markdown);
  } else {
    console.log(`✅ Generated release notes for ${nextTag} -> ${options.output}`);
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main();
}
