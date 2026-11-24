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
import http from 'node:http';
import https from 'node:https';
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
  const [a, b, c] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 169 && b === 254) return true; // Link-local / cloud metadata 169.254.0.0/16 (always forbidden)
  if (a === 100 && b === 100 && c === 100 && parts[3] === 200) return true; // Alibaba Cloud metadata 100.100.100.200 (always forbidden)
  if (a === 192 && b === 0 && c === 0) return true; // IETF Protocol Assignments 192.0.0.0/24
  if (a >= 224) return true; // Multicast & reserved (always forbidden)
  if (a === 127) return !allowLoopback; // Loopback 127.0.0.0/8
  if (a === 10) return !allowPrivateNet; // RFC1918 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return !allowPrivateNet; // CGNAT 100.64.0.0/10
  if (a === 172 && b >= 16 && b <= 31) return !allowPrivateNet; // RFC1918 172.16.0.0/12
  if (a === 192 && b === 168) return !allowPrivateNet; // RFC1918 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return !allowPrivateNet; // RFC2544 benchmark/mesh 198.18.0.0/15
  return false;
}

function expandIpv6Groups(rawIp) {
  let ip = String(rawIp || '').trim().toLowerCase();
  const lastColon = ip.lastIndexOf(':');
  if (lastColon !== -1 && ip.slice(lastColon + 1).includes('.')) {
    const v4 = ip.slice(lastColon + 1).split('.').map(Number);
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    ip = `${ip.slice(0, lastColon)}:${hi}:${lo}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - (left.length + right.length);
  if (halves.length === 1 ? left.length !== 8 : missing < 0) return null;
  const groups = halves.length === 2 ? [...left, ...Array(missing).fill('0'), ...right] : left;
  const nums = groups.map((g) => parseInt(g || '0', 16));
  if (nums.length !== 8 || nums.some((n) => !Number.isFinite(n) || n < 0 || n > 0xffff)) return null;
  return nums;
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
    const groups = expandIpv6Groups(ip);
    if (!groups) return true;
    const isAllZero = groups.every((g) => g === 0);
    if (isAllZero) return true; // ::/128
    const isLoopback = groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
    if (isLoopback) return !allowLoopback; // ::1/128 (canonical & non-canonical)
    if ((groups[0] & 0xff00) === 0xff00) return true; // Multicast ff00::/8
    if ((groups[0] & 0xffc0) === 0xfe80) return true; // Link-local fe80::/10
    if ((groups[0] & 0xffc0) === 0xfec0) return true; // Deprecated site-local fec0::/10
    if (groups[0] === 0xfd00 && groups[1] === 0x0ec2) return true; // AWS EC2 IMDSv2 IPv6 metadata
    if (groups[0] === 0x0100 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0) return true; // Discard 100::/64
    if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true; // Documentation 2001:db8::/32
    if (groups[0] === 0x2001 && groups[1] === 0x0000) return true; // Teredo 2001:0000::/32 (XOR-encoded IPv4 SSRF)
    if (groups[0] === 0x2002) return true; // Deprecated 6to4 2002::/16 relay/tunnel SSRF
    if ((groups[0] & 0xfe00) === 0xfc00) return !allowPrivateNet; // ULA fc00::/7
    if (groups[0] === 0x0064 && groups[1] === 0xff9b) return true; // NAT64 64:ff9b::/96
    // IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96), or RFC 2765 IPv4-translated (::ffff:0:0:0/96) IPv6
    const zeroPrefix5 = groups.slice(0, 5).every((g) => g === 0);
    const isIpv4Translated =
      groups.slice(0, 4).every((g) => g === 0) && groups[4] === 0xffff && groups[5] === 0x0000;
    if ((zeroPrefix5 && (groups[5] === 0xffff || groups[5] === 0x0000)) || isIpv4Translated) {
      const hi = groups[6];
      const lo = groups[7];
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
  const trimmed = rawUrl.trim();
  // Block ASCII control characters, whitespace, or backslashes before WHATWG URL normalization
  if (/[\x00-\x20\x7f\\]/.test(trimmed)) {
    throw new Error(`Security Error: Invalid ${label} '${rawUrl}' (contains control characters, whitespace, or backslashes).`);
  }
  const rawHostMatch = trimmed.match(/^(https?):\/\/([^/?#]+)/i);
  if (!rawHostMatch) {
    throw new Error(`Security Error: Disallowed or malformed ${label} '${rawUrl}'. Must start with http:// or https://.`);
  }
  const rawAuthority = rawHostMatch[2];
  if (rawAuthority.includes('@')) {
    throw new Error(`Security Error: Embedded credentials in ${label} are forbidden.`);
  }
  const rawHostOnly = (
    rawAuthority.startsWith('[')
      ? rawAuthority.slice(0, rawAuthority.indexOf(']') + 1)
      : rawAuthority.split(':')[0]
  )
    .toLowerCase()
    .replace(/\.+$/, '');
  if (!rawHostOnly) {
    throw new Error(`Security Error: Invalid ${label} '${rawUrl}'.`);
  }
  // Reject non-standard integer/hex/octal IP representations before URL normalization converts them to 127.0.0.1
  if (!rawHostOnly.startsWith('[') && /^(?:0x[0-9a-f]+|\d+|0[0-7]+)(?:\.(?:0x[0-9a-f]+|0[0-7]+|\d+)){0,3}$/i.test(rawHostOnly)) {
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(rawHostOnly) || /(?:^|\.)0\d+/.test(rawHostOnly)) {
      throw new Error(`Security Error: Non-canonical numeric/octal/hex IP host '${rawHostOnly}' in ${label} is forbidden (SSRF protection).`);
    }
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
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
  const bareHost = host.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  const isExplicitLoopback =
    rawHostOnly === 'localhost' || rawHostOnly === '127.0.0.1' || rawHostOnly === '[::1]';
  const allowedHosts = new Set(
    String(env.ALLOWED_TARGET_HOSTS || '')
      .split(',')
      .map((h) => h.trim().toLowerCase().replace(/\.+$/, ''))
      .filter(Boolean)
  );
  const effectiveAllowPrivate =
    allowPrivateNet !== undefined
      ? Boolean(allowPrivateNet)
      : env.CORTEX_ALLOW_PRIVATE_NET === '1' ||
        env.CORTEX_ALLOW_PRIVATE_NET === 'true' ||
        allowedHosts.has(host) ||
        allowedHosts.has(bareHost);

  if (bareHost.endsWith('.localhost') && !allowedHosts.has(bareHost)) {
    throw new Error(
      `Security Error: Wildcard loopback subdomain '${parsed.hostname}' in ${label} is forbidden unless explicitly listed in ALLOWED_TARGET_HOSTS.`
    );
  }

  if (
    FORBIDDEN_HOSTS.has(host) ||
    FORBIDDEN_HOSTS.has(bareHost) ||
    /^169\.254\./.test(bareHost) ||
    /^\[(?:0*:)*ffff:(?:a9fe:|169\.254\.)/i.test(host) ||
    /^\[?64:ff9b:/i.test(host) ||
    /^\[fe[89ab][0-9a-f]:/i.test(host) ||
    /^\[fec0:/i.test(host) ||
    /^\[fd00:ec2:/i.test(host) ||
    /^\[2002:/i.test(host) ||
    /^\[2001:0*:/i.test(host) ||
    (net.isIP(bareHost) !== 0 &&
      isForbiddenIpAddress(bareHost, {
        allowLoopback: isExplicitLoopback,
        allowPrivateNet: effectiveAllowPrivate,
      }))
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
  if (
    parsed.protocol === 'http:' &&
    env.CORTEX_CLOUD_TOKEN &&
    env.CORTEX_ALLOW_INSECURE_LOCAL_CLOUD !== '1' &&
    env.CORTEX_ALLOW_INSECURE_LOCAL_CLOUD !== 'true'
  ) {
    throw new Error(
      'Security Error: Refusing to transmit CORTEX_CLOUD_TOKEN over unencrypted http:// without CORTEX_ALLOW_INSECURE_LOCAL_CLOUD=1.'
    );
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

export async function assertSafeResolvedCloudTarget(
  safeUrl,
  { allowPrivateNet = false, allowLoopback } = {}
) {
  const parsed = new URL(safeUrl);
  const host = parsed.hostname.toLowerCase();
  const bareHost = host.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  const isLocalHost =
    allowLoopback !== undefined
      ? Boolean(allowLoopback)
      : host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (net.isIP(bareHost) !== 0) {
    if (isForbiddenIpAddress(bareHost, { allowLoopback: isLocalHost, allowPrivateNet })) {
      throw new Error(`Security Error: Target IP '${bareHost}' is forbidden (SSRF protection).`);
    }
    return { address: bareHost, family: net.isIP(bareHost) };
  }
  if (host === 'localhost') {
    if (!isLocalHost) {
      throw new Error(`Security Error: Loopback target '${host}' is forbidden (SSRF protection).`);
    }
    return { address: '127.0.0.1', family: 4 };
  }
  const records = await dns.lookup(bareHost, { all: true });
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(`Security Error: Host '${bareHost}' failed DNS resolution.`);
  }
  for (const rec of records) {
    if (isForbiddenIpAddress(rec.address, { allowLoopback: false, allowPrivateNet })) {
      throw new Error(
        `Security Error: Host '${bareHost}' resolves to private/internal IP '${rec.address}' (SSRF protection).`
      );
    }
  }
  return { address: records[0].address, family: records[0].family };
}

/**
 * Performs an HTTP/HTTPS request pinned to the DNS record validated by assertSafeResolvedCloudTarget,
 * preventing TOCTOU DNS rebinding between lookup and socket connection.
 */
export function safePinnedHttpRequest(
  safeUrl,
  { method = 'GET', headers = {}, body = null, timeoutMs = 10000, pinnedTarget = null, maxBytes = 2 * 1024 * 1024 } = {}
) {
  const parsed = new URL(safeUrl);
  const transport = parsed.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const reqOpts = {
      protocol: parsed.protocol,
      hostname: parsed.hostname.replace(/^\[|\]$/g, ''),
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers,
      timeout: timeoutMs,
    };
    if (parsed.protocol === 'https:') {
      reqOpts.servername = parsed.hostname.replace(/^\[|\]$/g, '');
    }
    if (pinnedTarget?.address && net.isIP(reqOpts.hostname) === 0) {
      reqOpts.lookup = (_host, opts, cb) => {
        if (opts && opts.all) {
          cb(null, [{ address: pinnedTarget.address, family: pinnedTarget.family }]);
        } else {
          cb(null, pinnedTarget.address, pinnedTarget.family);
        }
      };
    }
    const req = transport.request(reqOpts, (res) => {
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          req.destroy(new Error(`Response exceeded ${maxBytes}-byte safety limit.`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
          headers: res.headers,
          bodyBuffer: Buffer.concat(chunks),
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Request timed out after ${timeoutMs}ms.`)));
    req.on('error', reject);
    if (body !== null && body !== undefined) {
      req.write(body);
    }
    req.end();
  });
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
  let manifestVersion = null;
  const manifestPath = path.join(ROOT, '.agents/framework-manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (m.version && String(m.version) !== '0.1.0') manifestVersion = String(m.version);
    } catch {
      /* ignore */
    }
  }
  let changelogVersion = null;
  const changelogPath = path.join(ROOT, 'CHANGELOG.json');
  if (fs.existsSync(changelogPath)) {
    try {
      const c = JSON.parse(fs.readFileSync(changelogPath, 'utf8'));
      if (c.latestVersion) changelogVersion = String(c.latestVersion);
    } catch {
      /* ignore */
    }
  }
  if (manifestVersion) return manifestVersion;
  if (changelogVersion) return changelogVersion;
  for (const pkgCandidate of [path.resolve(__dirname, '..', 'package.json'), path.join(ROOT, 'package.json')]) {
    if (!fs.existsSync(pkgCandidate)) continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgCandidate, 'utf8'));
      if (pkg.name === 'agentic-solid-qe' && pkg.version) return String(pkg.version);
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
    const realRoot = fs.realpathSync(path.resolve(ROOT));
    const resolvedOut = path.resolve(realRoot, outFile);
    const relOut = path.relative(realRoot, resolvedOut).replace(/\\/g, '/');
    if (!relOut || relOut.startsWith('..') || path.isAbsolute(relOut)) {
      console.error(`❌ Security Error: --out path '${outFile}' must stay inside repository root.`);
      process.exit(1);
    }
    if (
      !relOut.endsWith('.json') ||
      relOut === 'package.json' ||
      relOut === 'package-lock.json' ||
      relOut === 'CHANGELOG.json' ||
      relOut === 'tsconfig.json' ||
      relOut.startsWith('.git/') ||
      relOut.startsWith('node_modules/') ||
      relOut.startsWith('scripts/') ||
      relOut.startsWith('src/')
    ) {
      console.error(
        `❌ Security Error: --out path '${relOut}' must be a .json report artifact outside protected source/config directories.`
      );
      process.exit(1);
    }
    let cur = resolvedOut;
    while (cur !== realRoot) {
      try {
        const st = fs.lstatSync(cur);
        if (st.isSymbolicLink()) {
          console.error(`❌ Security Error: Refusing to write through symbolic link '${path.relative(realRoot, cur)}'.`);
          process.exit(1);
        }
        const realCur = fs.realpathSync(cur);
        const relReal = path.relative(realRoot, realCur);
        if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
          console.error(`❌ Security Error: Output ancestor '${path.relative(realRoot, cur)}' escapes repository root.`);
          process.exit(1);
        }
      } catch (err) {
        if (err?.code !== 'ENOENT') {
          console.error(`❌ Security Error: Unable to inspect output path '${path.relative(realRoot, cur)}'.`);
          process.exit(1);
        }
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
    fs.writeFileSync(resolvedOut, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    console.log(`📝 Wrote sanitized Cortex report -> ${relOut}`);
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
  let pinnedTarget;
  try {
    safeUrl = assertSafeCloudUrl(cloudUrl);
    if (
      safeUrl.startsWith('http://') &&
      process.env.CORTEX_ALLOW_INSECURE_LOCAL_CLOUD !== '1' &&
      process.env.CORTEX_ALLOW_INSECURE_LOCAL_CLOUD !== 'true'
    ) {
      throw new Error(
        'Security Policy: Refusing to transmit CORTEX_CLOUD_TOKEN over plaintext http:// without CORTEX_ALLOW_INSECURE_LOCAL_CLOUD=1.'
      );
    }
    pinnedTarget = await assertSafeResolvedCloudTarget(safeUrl);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  const bodyStr = JSON.stringify(payload);
  const res = await safePinnedHttpRequest(safeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(bodyStr)),
      Authorization: `Bearer ${cloudToken}`,
      'User-Agent': `agentic-solid-qe/${payload.cliVersion}`,
    },
    body: bodyStr,
    timeoutMs: 10000,
    pinnedTarget,
  });

  if (res.status >= 300 && res.status < 400) {
    console.error(`❌ Security Error: Cortex Cloud endpoint attempted an unexpected HTTP ${res.status} redirect.`);
    process.exit(1);
  }
  if (!res.ok) {
    const errText = res.bodyBuffer.toString('utf8');
    console.error(`❌ Cortex Cloud upload failed (HTTP ${res.status}): ${errText.slice(0, 300)}`);
    process.exit(1);
  }

  let data = {};
  try {
    data = JSON.parse(res.bodyBuffer.toString('utf8'));
  } catch {}
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
