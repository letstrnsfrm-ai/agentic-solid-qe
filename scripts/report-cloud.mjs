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
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { computeTokenFootprint } from './lib/cli-output.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = process.cwd();

const FORBIDDEN_HOSTS = new Set([
  '0.0.0.0',
  '[::]',
  '::',
  '169.254.169.254',
  '169.254.170.2',
  '100.100.100.200',
  '[fd00:ec2::254]',
  'fd00:ec2::254',
  'metadata.google.internal',
  'metadata.azure.com',
  'metadata',
  'instance-data',
]);

function isForbiddenIpv4(ip, { allowLoopback = false, allowPrivateNet = false } = {}) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 169 && b === 254) return true; // Link-local / cloud metadata 169.254.0.0/16 (always forbidden)
  if (a === 100 && b === 100 && parts[2] === 100 && parts[3] === 200) return true; // Alibaba Cloud metadata 100.100.100.200 (always forbidden)
  if (a >= 224) return true; // Multicast & reserved (always forbidden)
  if (a === 127) return !allowLoopback; // Loopback 127.0.0.0/8
  if (a === 10) return !allowPrivateNet; // RFC1918 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return !allowPrivateNet; // CGNAT 100.64.0.0/10
  if (a === 172 && b >= 16 && b <= 31) return !allowPrivateNet; // RFC1918 172.16.0.0/12
  if (a === 192 && b === 168) return !allowPrivateNet; // RFC1918 192.168.0.0/16
  return false;
}

export function isForbiddenIpAddress(rawIp, { allowLoopback = false, allowPrivateNet = false } = {}) {
  const ip = String(rawIp || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!ip) return true;
  // Catch NAT64 well-known prefix 64:ff9b::/96 (both dotted-quad and hex forms, even if net.isIP rejects mixed form)
  if (/^64:ff9b:/i.test(ip)) return true;
  const family = net.isIP(ip);
  if (family === 4) {
    return isForbiddenIpv4(ip, { allowLoopback, allowPrivateNet });
  }
  if (family === 6) {
    if (ip === '::' || ip === '0:0:0:0:0:0:0:0') return true;
    if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') return !allowLoopback;
    if (/^fe[89ab][0-9a-f]:/.test(ip)) return true; // Link-local fe80::/10
    if (/^fd00:ec2::/.test(ip)) return true; // AWS EC2 IMDSv2 IPv6 metadata (always forbidden)
    if (/^f[cd][0-9a-f]{2}:/.test(ip)) return !allowPrivateNet; // ULA fc00::/7
    // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 or ::ffff:a9fe:a9fe)
    const v4Dotted = ip.match(/^(?:0*:)*ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4Dotted) return isForbiddenIpv4(v4Dotted[1], { allowLoopback, allowPrivateNet });
    const v4Hex = ip.match(/^(?:0*:)*ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (v4Hex) {
      const hi = parseInt(v4Hex[1], 16);
      const lo = parseInt(v4Hex[2], 16);
      const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isForbiddenIpv4(dotted, { allowLoopback, allowPrivateNet });
    }
    return false;
  }
  return false;
}

/**
 * Validates a target application HTTP/HTTPS URL against SSRF, cloud metadata endpoints,
 * link-local/NAT64/multicast ranges, and RFC1918/CGNAT private networks (unless localhost
 * or explicitly permitted by CORTEX_ALLOW_PRIVATE_NET=1 or ALLOWED_TARGET_HOSTS).
 */
export function assertSafeTargetHttpUrl(rawUrl, { label = 'URL', env = process.env, allowPrivateNet } = {}) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new Error(`Security Error: Invalid ${label} '${rawUrl}'.`);
  }
  // Reject non-standard integer/hex/octal IP representations before URL normalization converts them
  const rawHostMatch = rawUrl.trim().match(/^https?:\/\/([^/?#]+)/i);
  if (rawHostMatch) {
    const rawHostOnly = rawHostMatch[1].split('@').pop().split(':')[0].toLowerCase();
    if (/^(?:0x[0-9a-f]+|\d+|0[0-7]+)(?:\.(?:0x[0-9a-f]+|0[0-7]+|\d+)){0,3}$/i.test(rawHostOnly)) {
      if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(rawHostOnly) || /(?:^|\.)0\d+/.test(rawHostOnly)) {
        throw new Error(`Security Error: Non-canonical numeric/octal/hex IP host '${rawHostOnly}' in ${label} is forbidden (SSRF protection).`);
      }
    }
  }
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error(`Security Error: Invalid ${label} '${rawUrl}'.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Security Error: Disallowed ${label} protocol '${parsed.protocol}'. Only http: and https: are permitted.`
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Security Error: Embedded credentials in ${label} are forbidden.`);
  }
  const host = parsed.hostname.toLowerCase();
  const bareHost = host.replace(/^\[|\]$/g, '');
  const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  const allowedHosts = new Set(
    String(env.ALLOWED_TARGET_HOSTS || '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
  );
  const effectiveAllowPrivate =
    allowPrivateNet !== undefined
      ? Boolean(allowPrivateNet)
      : env.CORTEX_ALLOW_PRIVATE_NET === '1' ||
        env.CORTEX_ALLOW_PRIVATE_NET === 'true' ||
        allowedHosts.has(host) ||
        allowedHosts.has(bareHost);

  if (
    FORBIDDEN_HOSTS.has(host) ||
    FORBIDDEN_HOSTS.has(bareHost) ||
    /^169\.254\./.test(host) ||
    /^\[(?:0*:)*ffff:(?:a9fe:|169\.254\.)/i.test(host) ||
    /^\[?64:ff9b:/i.test(host) ||
    /^\[fe[89ab][0-9a-f]:/i.test(host) ||
    /^\[fd00:ec2::/i.test(host) ||
    (net.isIP(bareHost) !== 0 &&
      isForbiddenIpAddress(bareHost, { allowLoopback: isLocalHost, allowPrivateNet: effectiveAllowPrivate }))
  ) {
    throw new Error(
      `Security Error: Cloud metadata / link-local address or private host '${parsed.hostname}' in ${label} is forbidden (SSRF protection).`
    );
  }
  return parsed.toString();
}

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
  const validated = assertSafeTargetHttpUrl(rawUrl, {
    label: 'CORTEX_CLOUD_URL',
    env,
    allowPrivateNet: false,
  });
  const parsed = new URL(validated);
  const host = parsed.hostname.toLowerCase();
  const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (parsed.protocol === 'http:' && !isLocalHost) {
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

export async function assertSafeResolvedCloudTarget(safeUrl, { allowPrivateNet = false } = {}) {
  const parsed = new URL(safeUrl);
  const host = parsed.hostname.toLowerCase();
  const bareHost = host.replace(/^\[|\]$/g, '');
  const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (isLocalHost || net.isIP(bareHost) !== 0) {
    if (
      net.isIP(bareHost) !== 0 &&
      isForbiddenIpAddress(bareHost, { allowLoopback: isLocalHost, allowPrivateNet })
    ) {
      throw new Error(`Security Error: Target IP '${bareHost}' is forbidden (SSRF protection).`);
    }
    return;
  }
  const records = await dns.lookup(bareHost, { all: true });
  for (const rec of records) {
    if (isForbiddenIpAddress(rec.address, { allowLoopback: false, allowPrivateNet })) {
      throw new Error(
        `Security Error: Host '${bareHost}' resolves to private/internal IP '${rec.address}' (SSRF protection).`
      );
    }
  }
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
    tokenFootprint: computeTokenFootprint(ROOT),
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
    const resolvedRoot = path.resolve(ROOT);
    const resolvedOut = path.resolve(resolvedRoot, outFile);
    const relOut = path.relative(resolvedRoot, resolvedOut);
    if (relOut.startsWith('..') || path.isAbsolute(relOut)) {
      console.error(`❌ Security Error: --out path '${outFile}' must stay inside repository root.`);
      process.exit(1);
    }
    let cur = resolvedOut;
    while (cur !== resolvedRoot) {
      if (fs.existsSync(cur) && fs.lstatSync(cur).isSymbolicLink()) {
        console.error(`❌ Security Error: Refusing to write through symbolic link '${path.relative(resolvedRoot, cur)}'.`);
        process.exit(1);
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
    fs.writeFileSync(resolvedOut, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    console.log(`📝 Wrote sanitized Cortex report -> ${path.relative(resolvedRoot, resolvedOut)}`);
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
    await assertSafeResolvedCloudTarget(safeUrl);
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
