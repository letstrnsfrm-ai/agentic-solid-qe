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
  if (process.env.GITHUB_REPOSITORY) {
    return process.env.GITHUB_REPOSITORY;
  }
  const remoteUrl = git(['config', '--get', 'remote.origin.url'], { allowFailure: true });
  const match = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/);
  return match ? match[1] : 'letstrnsfrm-ai/agentic-solid-qe';
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
        /BREAKING[ -]CHANGE/i.test(body) ||
        /BREAKING[ -]CHANGE/i.test(subject);
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
    const filePath = parts.slice(2).join('\t').trim();
    totalInsertions += added;
    totalDeletions += deleted;
    statsByFile.set(filePath, { added, deleted });
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
  const releaseTitle = headlineCommit
    ? `${nextTag} — ${headlineCommit.subject}`
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
    for (const commit of matching) {
      const scopePrefix = commit.scope ? `**${commit.scope}:** ` : '';
      const commitUrl = `https://github.com/${repoSlug}/commit/${commit.hash}`;
      const authorSuffix = commit.author ? ` by **${commit.author}**` : '';
      sections.push(
        `- ${scopePrefix}${commit.description} ([\`${commit.shortHash}\`](${commitUrl}))${authorSuffix}`
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
        .map((f) => `\`${f.path}\``)
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
        `| ${statusBadge(file.status)} | \`${file.path}\` | \`+${file.added}\` / \`-${file.deleted}\` |`
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
  sections.push('# or directly via npx:');
  sections.push(`npx --yes github:${repoSlug} sync`);
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

function parseCliArgs(argv) {
  const options = {
    dryRun: false,
    output: null,
    jsonMeta: null,
    beforeSha: process.env.GITHUB_EVENT_BEFORE || null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--output' && argv[i + 1]) {
      options.output = argv[i + 1];
      i += 1;
    } else if (arg === '--json-meta' && argv[i + 1]) {
      options.jsonMeta = argv[i + 1];
      i += 1;
    } else if (arg === '--before' && argv[i + 1]) {
      options.beforeSha = argv[i + 1];
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
      fs.writeFileSync(path.resolve(ROOT, options.jsonMeta), JSON.stringify(meta, null, 2), 'utf8');
    }
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `should_release=false\n`, 'utf8');
    }
    console.log(`⏭️  Skipping release: ${meta.reason}`);
    return;
  }

  const latestTag = getLatestVersionTag();
  const latestTagSemver = latestTag ? parseSemver(latestTag) : null;

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
  const nextSemver = bumpSemver(baseSemver, bumpType);
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

  if (options.output) {
    fs.writeFileSync(path.resolve(ROOT, options.output), markdown, 'utf8');
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
    fs.writeFileSync(path.resolve(ROOT, options.jsonMeta), JSON.stringify(meta, null, 2), 'utf8');
  }

  if (process.env.GITHUB_OUTPUT && !options.dryRun) {
    const outputLines = [
      `should_release=true`,
      `next_tag=${nextTag}`,
      `bump_type=${bumpType}`,
      `release_title<<EOF`,
      releaseTitle,
      `EOF`,
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

main();
