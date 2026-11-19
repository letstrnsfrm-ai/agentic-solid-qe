#!/usr/bin/env node
/**
 * Opt-in Cortex Cloud Governance Telemetry Emitter (`npx cortex report`).
 *
 * Collects sanitized Stage 0-4 maturity, SOLID audit status, and aggregate counts
 * (no secrets, URLs, or raw test code) and posts to CORTEX_CLOUD_URL.
 *
 * Usage:
 *   npx cortex report --dry-run
 *   npx cortex report --out .exploratory/cortex-report.json
 *   CORTEX_CLOUD_URL=https://cloud.example.com/api/v1/reports CORTEX_CLOUD_TOKEN=... npx cortex report
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = process.cwd();

const FORBIDDEN_HOSTS = new Set([
  '0.0.0.0',
  '[::]',
  '169.254.169.254',
  '169.254.170.2',
  '100.100.100.200',
  '[fd00:ec2::254]',
  'metadata.google.internal',
  'metadata.azure.com',
  'metadata',
  'instance-data',
]);

export function assertSafeCloudUrl(rawUrl, env = process.env) {
  if (
    env.CORTEX_OFFLINE === '1' ||
    env.CORTEX_OFFLINE === 'true' ||
    env.CORTEX_NO_NETWORK === '1' ||
    env.CORTEX_NO_NETWORK === 'true'
  ) {
    throw new Error(
      'Security Policy: Outbound Cortex Cloud telemetry is disabled when CORTEX_OFFLINE=1 or CORTEX_NO_NETWORK=1.'
    );
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid CORTEX_CLOUD_URL '${rawUrl}'.`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Unsupported CORTEX_CLOUD_URL protocol '${parsed.protocol}'.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('Embedded credentials in CORTEX_CLOUD_URL are forbidden.');
  }
  const host = parsed.hostname.toLowerCase();
  if (
    FORBIDDEN_HOSTS.has(host) ||
    /^169\.254\./.test(host) ||
    /^\[(?:0*:)*ffff:(?:a9fe:|169\.254\.)/i.test(host) ||
    /^\[fe80:/i.test(host)
  ) {
    throw new Error(`Cloud metadata / link-local host '${parsed.hostname}' is forbidden (SSRF protection).`);
  }
  if (parsed.protocol === 'http:' && host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') {
    throw new Error('CORTEX_CLOUD_URL must use https:// for non-localhost endpoints.');
  }
  const allowedHostsRaw = (env.CORTEX_ALLOWED_CLOUD_HOSTS || '').trim();
  if (allowedHostsRaw) {
    const allowedHosts = new Set(
      allowedHostsRaw
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean)
    );
    if (allowedHosts.size > 0 && !allowedHosts.has(host)) {
      throw new Error(
        `Security Policy: CORTEX_CLOUD_URL host '${host}' is not in CORTEX_ALLOWED_CLOUD_HOSTS.`
      );
    }
  }
  return parsed.toString();
}

function detectCiProvider() {
  if (process.env.GITHUB_ACTIONS === 'true') return 'github-actions';
  if (process.env.TF_BUILD === 'True' || process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI) return 'azure-devops';
  if (process.env.GITLAB_CI === 'true') return 'gitlab-ci';
  return 'local';
}

function gitCmd(args) {
  const res = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 3000 });
  return res.status === 0 ? res.stdout.trim() : '';
}

function detectRepoName() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY.trim();
  const remote = gitCmd(['config', '--get', 'remote.origin.url']);
  const match = remote.match(/[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (match) return match[1];
  return path.basename(ROOT) || 'unknown-repo';
}

function detectBranch() {
  return (
    process.env.GITHUB_REF_NAME ||
    process.env.BUILD_SOURCEBRANCHNAME ||
    process.env.CI_COMMIT_REF_NAME ||
    gitCmd(['rev-parse', '--abbrev-ref', 'HEAD']) ||
    'main'
  );
}

function detectCommitSha() {
  const sha =
    process.env.GITHUB_SHA ||
    process.env.BUILD_SOURCEVERSION ||
    process.env.CI_COMMIT_SHA ||
    gitCmd(['rev-parse', '--short', 'HEAD']);
  return sha ? sha.slice(0, 40) : null;
}

function readCliVersion() {
  for (const pkgCandidate of [path.join(ROOT, 'package.json'), path.resolve(__dirname, '..', 'package.json')]) {
    if (!fs.existsSync(pkgCandidate)) continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgCandidate, 'utf8'));
      if (pkg.version) return String(pkg.version);
    } catch {
      /* ignore */
    }
  }
  return '0.0.0';
}

function detectPrNumber(explicitPr) {
  if (explicitPr && /^\d+$/.test(String(explicitPr))) return Number(explicitPr);
  const ghRef = process.env.GITHUB_REF || '';
  const ghMatch = ghRef.match(/^refs\/pull\/(\d+)\//);
  if (ghMatch) return Number(ghMatch[1]);
  const adoPr = process.env.SYSTEM_PULLREQUEST_PULLREQUESTNUMBER || process.env.CI_MERGE_REQUEST_IID || '';
  if (/^\d+$/.test(adoPr)) return Number(adoPr);
  return null;
}

export function buildSanitizedReport({ prNumber } = {}) {
  const coverageScript = path.join(__dirname, 'analyze-coverage.mjs');
  const auditScript = path.join(__dirname, 'audit-solid.mjs');

  const covRes = spawnSync(process.execPath, [coverageScript, '--summary'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  let covJson = {};
  if (covRes.stdout) {
    const jsonStart = covRes.stdout.indexOf('{');
    if (jsonStart !== -1) {
      try {
        covJson = JSON.parse(covRes.stdout.slice(jsonStart));
      } catch {
        covJson = {};
      }
    }
  }

  const auditRes = spawnSync(process.execPath, [auditScript], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const solidPassed = auditRes.status === 0;
  const auditOutput = `${auditRes.stdout || ''}\n${auditRes.stderr || ''}`;
  const violationLines = auditOutput
    .split(/\r?\n/)
    .filter((line) => /^\s*-\s+\[[^\]]+\]/.test(line));

  const stageObj = covJson.coverageMaturityStage || {};
  const counts = covJson.counts || {};

  return {
    schemaVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    cliVersion: readCliVersion(),
    ciProvider: detectCiProvider(),
    repositoryName: detectRepoName(),
    branch: detectBranch(),
    commitSha: detectCommitSha(),
    prNumber: detectPrNumber(prNumber),
    maturityStage: Number.isInteger(stageObj.stage) ? stageObj.stage : 0,
    maturityStageName: String(stageObj.name || 'Stage 0: Onboarding'),
    solidPassed,
    violationCount: solidPassed ? 0 : Math.max(1, violationLines.length),
    shardCount: Number(counts.domainShards ?? (covJson.domainShards || []).length ?? 0),
    uncoveredShardCount: Number(counts.uncoveredShards ?? (covJson.uncoveredShards || []).length ?? 0),
    uncompiledTapeCount: Number(counts.uncompiledTapes ?? (covJson.uncompiledTapes || []).length ?? 0),
    automatedSpecCount: Number(counts.automatedSpecs ?? (covJson.automatedSpecs || []).length ?? 0),
    componentCount: Number(counts.components ?? 0),
    pageCount: Number(counts.pages ?? 0),
    apiClientCount: Number(counts.apiClients ?? 0),
    openDefectCount: Number(counts.openDefects ?? 0),
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
📡 Cortex Report — Opt-In Governance Telemetry Emitter (schemaVersion: 1.0.0)

Usage:
  npx cortex report [options]

Options:
  --dry-run       Print sanitized JSON payload without uploading
  --out <path>    Write sanitized JSON payload to a file inside the repo

Environment:
  CORTEX_CLOUD_URL    Target ingestion endpoint (e.g. https://cloud.example.com/api/v1/reports)
  CORTEX_CLOUD_TOKEN  Bearer token for Cortex Cloud authentication
`);
    process.exit(0);
  }

  let dryRun = false;
  let outFile = '';
  let explicitPr = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--out' && args[i + 1]) outFile = args[++i];
    else if (args[i].startsWith('--out=')) outFile = args[i].slice('--out='.length);
    else if (args[i] === '--pr' && args[i + 1]) explicitPr = args[++i];
    else if (args[i].startsWith('--pr=')) explicitPr = args[i].slice('--pr='.length);
  }

  const payload = buildSanitizedReport({ prNumber: explicitPr });

  if (outFile) {
    const resolvedOut = path.resolve(ROOT, outFile);
    if (!resolvedOut.startsWith(ROOT + path.sep) && resolvedOut !== ROOT) {
      console.error(`❌ Security Error: --out path '${outFile}' must stay inside repository root.`);
      process.exit(1);
    }
    if (fs.existsSync(resolvedOut) && fs.lstatSync(resolvedOut).isSymbolicLink()) {
      console.error(`❌ Security Error: Refusing to overwrite symbolic link '${outFile}'.`);
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
    fs.writeFileSync(resolvedOut, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    console.log(`📝 Wrote sanitized Cortex report -> ${path.relative(ROOT, resolvedOut)}`);
  }

  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    process.exit(0);
  }

  const cloudUrl = (process.env.CORTEX_CLOUD_URL || '').trim();
  const cloudToken = (process.env.CORTEX_CLOUD_TOKEN || '').trim();
  if (!cloudUrl || !cloudToken) {
    if (!outFile) {
      console.log(
        'ℹ️  Cortex Cloud reporting is opt-in. Set CORTEX_CLOUD_URL and CORTEX_CLOUD_TOKEN, or pass --dry-run to preview.'
      );
    }
    process.exit(0);
  }

  let safeUrl;
  try {
    safeUrl = assertSafeCloudUrl(cloudUrl);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  const res = await fetch(safeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cloudToken}`,
      'User-Agent': `agentic-solid-qe/${payload.cliVersion}`,
    },
    body: JSON.stringify(payload),
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`❌ Cortex Cloud upload failed (HTTP ${res.status}): ${errText.slice(0, 300)}`);
    process.exit(1);
  }

  const data = await res.json().catch(() => ({}));
  console.log(`📡 Uploaded Cortex report (${payload.repositoryName}@${payload.branch}, Stage ${payload.maturityStage}) -> id=${data.id || 'ok'}`);
}

const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  main().catch((err) => {
    console.error(`❌ Cortex report failed: ${err?.message || err}`);
    process.exit(1);
  });
}
