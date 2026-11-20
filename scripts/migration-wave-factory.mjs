#!/usr/bin/env node
/**
 * Enterprise 2,000-Test Squad Wave Factory, Closed-Loop Live Verify/Heal Runner
 * & Interactive HTML Migration Burn-Down / N:1 Parity Dashboard (`npx cortex wave`).
 *
 * Solves 2,000+ test C#/.NET migration at scale:
 *   1. Resume-safe Migration Ledger (.agents/domain/migration-manifest.json)
 *   2. Token-bounded squad & wave micro-batches (--squad --wave --batch-size N --summary)
 *   3. Wave-0 Shared StateSeederContract & FlowContract scaffolding
 *   4. Closed-loop live Playwright verification + automatic cortex heal drift repair
 *   5. Interactive HTML Burn-Down & N:1 Parity Traceability Dashboard (reports/migration-dashboard.html)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { discoverLegacyTests, MIGRATION_MANIFEST_REL_PATH, assertSafeLegacyScanRoot } from './legacy-test-migrator.mjs';
import { resolveLocalBin } from './explore-session.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = process.cwd();

const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function assertSafeOutputPath(projectRoot, relOutPath) {
  if (typeof relOutPath !== 'string' || !relOutPath.trim() || path.isAbsolute(relOutPath) || relOutPath.includes('..')) {
    throw new Error(`Security Error: Unsafe dashboard output path '${relOutPath}'.`);
  }
  const resolved = path.resolve(projectRoot, relOutPath);
  const rel = path.relative(projectRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Security Error: Output path escapes repository root: '${relOutPath}'.`);
  }
  if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
    throw new Error(`Security Error: Refusing to write to symbolic link: '${relOutPath}'.`);
  }
  return resolved;
}

// ─── 1. Resume-Safe Migration Ledger ────────────────────────────────────────

export function initOrUpdateMigrationLedger(scanRoot, projectRoot = ROOT) {
  const safeScan = assertSafeLegacyScanRoot(scanRoot, projectRoot);
  const discovery = discoverLegacyTests(safeScan);
  const manifestPath = path.join(projectRoot, MIGRATION_MANIFEST_REL_PATH);
  let existing = null;
  if (fs.existsSync(manifestPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      existing = null;
    }
  }

  const prevEntries = new Map();
  for (const e of existing?.ledger || []) {
    if (e?.id) prevEntries.set(e.id, e);
  }
  const prevWave0 = new Map();
  for (const w of existing?.wave0Prereqs || []) {
    if (w?.id) prevWave0.set(w.id, w);
  }

  // Build N:1 consolidation map: mergedTestId -> canonicalTestId
  const consolidatedIntoMap = new Map();
  for (const grp of discovery.rationalization.consolidationGroups || []) {
    for (const id of grp.mergedTestIds) {
      if (id !== grp.canonicalTestId) {
        consolidatedIntoMap.set(id, grp.canonicalTestId);
      }
    }
  }

  const ledger = discovery.rationalization.triagedTests.map((t) => {
    const prev = prevEntries.get(t.id);
    const consolidatedInto = consolidatedIntoMap.get(t.id) || null;
    const defaultStatus =
      t.ledgerStatus === 'skipped-quarantine'
        ? 'skipped-quarantine'
        : consolidatedInto
          ? 'consolidated'
          : 'pending';
    return {
      id: t.id,
      testMethod: t.testMethod || t.name || t.id,
      file: t.file,
      squad: t.squad || 'core',
      wave: t.wave || 2,
      kind: t.kind || 'ui',
      valueScore: t.valueScore || 50,
      seederStrategy: t.seederProfile?.primaryStrategy || 'standalone',
      prefixKey: t.prefixKey || null,
      consolidatedInto,
      status: prev?.status && prev.status !== 'pending' ? prev.status : defaultStatus,
      targetSpec: prev?.targetSpec || null,
      skipReason: t.skipReason || prev?.skipReason || null,
      updatedAt: prev?.updatedAt || new Date().toISOString(),
    };
  });

  const wave0Prereqs = (discovery.rationalization.wave0Prereqs || []).map((w) => {
    const prev = prevWave0.get(w.id);
    return {
      ...w,
      status: prev?.status || 'pending',
      targetFile: prev?.targetFile || null,
    };
  });

  const manifest = {
    schemaVersion: '2.0.0',
    updatedAt: new Date().toISOString(),
    scanRoot: path.relative(projectRoot, safeScan).replace(/\\/g, '/') || '.',
    summary: discovery.rationalization.summary,
    squadBreakdown: discovery.rationalization.squadBreakdown,
    wave0Prereqs,
    consolidationGroups: discovery.rationalization.consolidationGroups,
    ledger,
  };

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return manifest;
}

// ─── 2. Token-Bounded Squad & Wave Micro-Batch Selector ─────────────────────

export function selectNextWaveBatch(manifest, { squad = '', wave = null, batchSize = 5 } = {}) {
  const safeLimit = Math.max(1, Math.min(25, Number(batchSize) || 5));
  if (squad && !SAFE_SLUG_RE.test(squad)) {
    throw new Error(`Invalid --squad '${squad}'. Must be kebab-case.`);
  }

  // Wave 0: shared seeders & flows first
  if (wave === 0) {
    const pendingWave0 = (manifest.wave0Prereqs || []).filter(
      (w) => w.status === 'pending' && (!squad || (w.squads || []).includes(squad))
    );
    return {
      wave: 0,
      squad: squad || 'all',
      remainingInQueue: pendingWave0.length,
      batch: pendingWave0.slice(0, safeLimit),
    };
  }

  const pendingTests = (manifest.ledger || []).filter((e) => {
    if (e.status !== 'pending') return false;
    if (squad && e.squad !== squad) return false;
    if (wave !== null && wave !== undefined && e.wave !== Number(wave)) return false;
    return true;
  });

  return {
    wave: wave ?? 'all',
    squad: squad || 'all',
    remainingInQueue: pendingTests.length,
    batch: pendingTests.slice(0, safeLimit),
  };
}

// ─── 3. Wave-0 Shared StateSeederContract / FlowContract Scaffolding ────────

export function scaffoldWave0Prereq(prereq, projectRoot = ROOT) {
  const squad = prereq.squads?.length === 1 && SAFE_SLUG_RE.test(prereq.squads[0]) ? prereq.squads[0] : '';
  const slug = String(prereq.id || 'shared-prereq').replace(/^wave0-/, '');
  const isSeeder = prereq.recommendedContract === 'StateSeederContract';
  const relDir = squad
    ? `src/domains/${squad}/${isSeeder ? 'seeders' : 'flows'}`
    : `src/${isSeeder ? 'seeders' : 'flows'}`;
  const relPath = `${relDir}/${slug}.${isSeeder ? 'seeder' : 'flow'}.ts`;
  const absPath = assertSafeOutputPath(projectRoot, relPath);

  const codeContent = isSeeder
    ? `import crypto from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import type { StateSeederContract } from '@contracts/state-seeder.contract';

/**
 * Wave-0 Shared State Seeder (SRP <= 150 lines, zero assertions, LSP: StateSeederContract).
 * Serves ${prereq.reuseCount} downstream migrated tests sharing prefix '${String(prereq.prefixKey || '').replace(/\*\//g, '')}'.
 */
export class ${prereq.className} implements StateSeederContract<Record<string, unknown>, Record<string, string>> {
  constructor(
    private readonly request: APIRequestContext,
    private readonly baseUrl: string
  ) {}

  async seed(input: Record<string, unknown> = {}): Promise<Record<string, string>> {
    void this.request;
    void this.baseUrl;
    void input;
    return { seedId: crypto.randomUUID() };
  }

  async teardown(handle: Record<string, string>): Promise<void> {
    void handle;
  }
}
`
    : `import type { Page } from '@playwright/test';
import type { FlowContract } from '@contracts/flow.contract';

/**
 * Wave-0 Shared Reusable UI Flow (SRP <= 150 lines, zero assertions, LSP: FlowContract).
 * Serves ${prereq.reuseCount} downstream migrated tests sharing prefix '${String(prereq.prefixKey || '').replace(/\*\//g, '')}'.
 */
export class ${prereq.className} implements FlowContract<void, Record<string, string>> {
  constructor(private readonly page: Page) {}

  async execute(): Promise<Record<string, string>> {
    await this.page.goto('/');
    return {};
  }
}
`;

  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, codeContent, 'utf8');
  return { relPath, className: prereq.className, contract: prereq.recommendedContract };
}

// ─── 4. Closed-Loop Live Verify + Auto-Heal Runner ──────────────────────────

export function runClosedLoopLiveVerifyAndHeal(specRelPath, projectRoot = ROOT) {
  const pwBin = resolveLocalBin('playwright', projectRoot);
  const firstRun = spawnSync(
    pwBin.command,
    [...pwBin.prefixArgs, 'test', specRelPath, '--project=chromium'],
    { cwd: projectRoot, encoding: 'utf8' }
  );
  if (firstRun.status === 0) {
    return { status: 'live-verified', healed: false };
  }

  const healScript = path.join(__dirname, 'heal-drift.mjs');
  if (fs.existsSync(healScript)) {
    const healRes = spawnSync(process.execPath, [healScript, '--spec', specRelPath, '--apply'], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    if (healRes.status === 0) {
      const retryRun = spawnSync(
        pwBin.command,
        [...pwBin.prefixArgs, 'test', specRelPath, '--project=chromium'],
        { cwd: projectRoot, encoding: 'utf8' }
      );
      if (retryRun.status === 0) {
        return { status: 'healed', healed: true };
      }
    }
  }
  return { status: 'needs-triage', healed: false };
}

// ─── 5. Interactive HTML Migration Burn-Down & N:1 Parity Dashboard ─────────

export function generateMigrationDashboard(projectRoot = ROOT, outRelPath = 'reports/migration-dashboard.html') {
  const manifestPath = path.join(projectRoot, MIGRATION_MANIFEST_REL_PATH);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing migration manifest at ${MIGRATION_MANIFEST_REL_PATH}. Run 'cortex wave --scan <dir>' first.`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const absOut = assertSafeOutputPath(projectRoot, outRelPath);

  const ledger = Array.isArray(manifest.ledger) ? manifest.ledger : [];
  const total = ledger.length;
  const verifiedCount = ledger.filter((e) => ['live-verified', 'healed', 'parity-verified'].includes(e.status)).length;
  const compiledCount = ledger.filter((e) => e.status === 'compiled').length;
  const skippedCount = ledger.filter((e) => e.status === 'skipped-quarantine').length;
  const consolidatedCount = ledger.filter((e) => e.status === 'consolidated').length;
  const activeTarget = Math.max(1, total - skippedCount - consolidatedCount);
  const verifiedPct = Math.round((verifiedCount / activeTarget) * 100);

  const squadMap = new Map();
  for (const e of ledger) {
    const sq = e.squad || 'core';
    if (!squadMap.has(sq)) squadMap.set(sq, { squad: sq, total: 0, done: 0, compiled: 0, skipped: 0 });
    const row = squadMap.get(sq);
    row.total++;
    if (['live-verified', 'healed', 'parity-verified', 'consolidated'].includes(e.status)) row.done++;
    else if (e.status === 'compiled') row.compiled++;
    else if (e.status === 'skipped-quarantine') row.skipped++;
  }

  const squadBarsHtml = [...squadMap.values()]
    .map((s) => {
      const denom = Math.max(1, s.total - s.skipped);
      const pct = Math.min(100, Math.round((s.done / denom) * 100));
      return `<div class="squad-row">
        <div class="squad-meta"><strong>${escapeHtml(s.squad)}</strong><span>${s.done}/${denom} verified (${pct}%) &middot; ${s.compiled} compiled &middot; ${s.skipped} quarantined</span></div>
        <div class="bar-bg"><div class="bar-fill" style="width:${pct}%"></div></div>
      </div>`;
    })
    .join('\n');

  const parityRowsHtml = ledger
    .slice(0, 500)
    .map(
      (e) => `<tr data-squad="${escapeHtml(e.squad)}" data-status="${escapeHtml(e.status)}" data-wave="${escapeHtml(e.wave)}">
        <td><code>${escapeHtml(e.id)}</code></td>
        <td>${escapeHtml(e.squad)}</td>
        <td>W${escapeHtml(e.wave)}</td>
        <td><span class="badge status-${escapeHtml(e.status)}">${escapeHtml(e.status)}</span></td>
        <td>${escapeHtml(e.seederStrategy || 'standalone')}</td>
        <td><code>${escapeHtml(e.consolidatedInto ? `-> ${e.consolidatedInto} (N:1)` : e.targetSpec || '-')}</code></td>
      </tr>`
    )
    .join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Cortex Migration Burn-Down &amp; N:1 Parity Dashboard</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 24px; }
    h1, h2 { margin: 0 0 12px; }
    .sub { color: #94a3b8; margin-bottom: 20px; font-size: 14px; }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 16px; }
    .card .val { font-size: 28px; font-weight: 700; color: #38bdf8; }
    .card .lbl { font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: .04em; }
    .panel { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 16px; margin-bottom: 20px; }
    .squad-row { margin-bottom: 12px; }
    .squad-meta { display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 4px; }
    .bar-bg { background: #0f172a; height: 10px; border-radius: 6px; overflow: hidden; }
    .bar-fill { background: linear-gradient(90deg, #38bdf8, #34d399); height: 100%; }
    .filters { display: flex; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
    input, select { background: #0f172a; color: #e2e8f0; border: 1px solid #475569; border-radius: 6px; padding: 6px 10px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #334155; }
    th { color: #94a3b8; font-weight: 600; }
    .badge { padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; background: #334155; }
    .status-live-verified, .status-healed, .status-parity-verified { background: #065f46; color: #a7f3d0; }
    .status-compiled { background: #1e40af; color: #bfdbfe; }
    .status-consolidated { background: #5b21b6; color: #ddd6fe; }
    .status-skipped-quarantine { background: #78350f; color: #fde68a; }
  </style>
</head>
<body>
  <h1>Cortex Legacy-to-SOLID Migration Burn-Down &amp; Parity Dashboard</h1>
  <div class="sub">Updated: ${escapeHtml(manifest.updatedAt)} &middot; Source: <code>${escapeHtml(manifest.scanRoot)}</code></div>
  <div class="kpis">
    <div class="card"><div class="val">${total}</div><div class="lbl">Legacy Tests Scanned</div></div>
    <div class="card"><div class="val">${escapeHtml(manifest.summary?.estimatedTargetSpecs ?? activeTarget)} (-${escapeHtml(manifest.summary?.reductionPct ?? 0)}%)</div><div class="lbl">Rationalized SOLID Target</div></div>
    <div class="card"><div class="val">${(manifest.wave0Prereqs || []).length}</div><div class="lbl">Wave-0 Shared Seeders/Flows</div></div>
    <div class="card"><div class="val">${verifiedPct}%</div><div class="lbl">Live-Verified / Healed</div></div>
    <div class="card"><div class="val">${skippedCount}</div><div class="lbl">Quarantined / Skipped</div></div>
  </div>
  <div class="panel">
    <h2>Squad Burn-Down</h2>
    ${squadBarsHtml || '<p>No squads indexed yet.</p>'}
  </div>
  <div class="panel">
    <h2>N:1 Legacy-to-Playwright Parity Traceability</h2>
    <div class="filters">
      <input id="q" placeholder="Filter by legacy test ID..." oninput="filterRows()" />
      <select id="st" onchange="filterRows()">
        <option value="">All Statuses</option>
        <option value="pending">pending</option>
        <option value="compiled">compiled</option>
        <option value="live-verified">live-verified</option>
        <option value="healed">healed</option>
        <option value="consolidated">consolidated (N:1)</option>
        <option value="skipped-quarantine">skipped-quarantine</option>
      </select>
    </div>
    <table>
      <thead><tr><th>Legacy Test ID</th><th>Squad</th><th>Wave</th><th>Status</th><th>Seeding</th><th>SOLID Target / N:1 Parity</th></tr></thead>
      <tbody id="rows">${parityRowsHtml}</tbody>
    </table>
  </div>
  <script>
    function filterRows() {
      const q = document.getElementById('q').value.toLowerCase();
      const st = document.getElementById('st').value;
      for (const tr of document.querySelectorAll('#rows tr')) {
        const matchQ = !q || tr.textContent.toLowerCase().includes(q);
        const matchSt = !st || tr.dataset.status === st;
        tr.style.display = matchQ && matchSt ? '' : 'none';
      }
    }
  </script>
</body>
</html>
`;

  fs.mkdirSync(path.dirname(absOut), { recursive: true });
  fs.writeFileSync(absOut, html, 'utf8');
  return { outPath: outRelPath, total, verifiedPct };
}

// ─── CLI Entrypoint ─────────────────────────────────────────────────────────

function getFlag(args, flag, fallback = undefined) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : fallback;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.log(`Usage: cortex wave [options]
  --scan <legacy-dir>      Scan/refresh resume-safe ledger (.agents/domain/migration-manifest.json)
  --squad <squad-slug>     Filter wave queue to a single federated squad
  --wave <0|1|2|3>         Select Wave 0 (shared seeders/flows) or Waves 1-3 (tests)
  --batch-size <N>         Token-bounded micro-batch size (default: 5, max: 25)
  --scaffold-wave0         Scaffold selected Wave-0 StateSeederContract / FlowContract files
  --dashboard [out-path]   Generate HTML Migration Burn-Down & N:1 Parity Dashboard (default: reports/migration-dashboard.html)
  --json                   Emit machine-readable JSON output
`);
    return;
  }

  const scanDir = getFlag(args, '--scan');
  const squad = getFlag(args, '--squad', '');
  const waveArg = getFlag(args, '--wave');
  const wave = waveArg !== undefined ? Number(waveArg) : null;
  const batchSize = Number(getFlag(args, '--batch-size', '5'));
  const scaffoldWave0 = args.includes('--scaffold-wave0');
  const wantDashboard = args.includes('--dashboard');
  const jsonOut = args.includes('--json');

  let manifest = null;
  if (scanDir) {
    manifest = initOrUpdateMigrationLedger(path.resolve(ROOT, scanDir), ROOT);
  } else {
    const manifestPath = path.join(ROOT, MIGRATION_MANIFEST_REL_PATH);
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`No migration ledger found at ${MIGRATION_MANIFEST_REL_PATH}. Pass --scan <legacy-dir>.`);
    }
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  }

  const selection = selectNextWaveBatch(manifest, { squad, wave, batchSize });
  const scaffolded = [];
  if (scaffoldWave0 && selection.wave === 0) {
    for (const prereq of selection.batch) {
      const res = scaffoldWave0Prereq(prereq, ROOT);
      prereq.status = 'wave0-scaffolded';
      prereq.targetFile = res.relPath;
      scaffolded.push(res);
    }
    fs.writeFileSync(path.join(ROOT, MIGRATION_MANIFEST_REL_PATH), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  }

  let dashboard = null;
  if (wantDashboard) {
    const dashIdx = args.indexOf('--dashboard');
    const customOut =
      dashIdx !== -1 && args[dashIdx + 1] && !args[dashIdx + 1].startsWith('--')
        ? args[dashIdx + 1]
        : 'reports/migration-dashboard.html';
    dashboard = generateMigrationDashboard(ROOT, customOut);
  }

  const output = {
    summary: manifest.summary,
    selection,
    ...(scaffolded.length > 0 ? { scaffolded } : {}),
    ...(dashboard ? { dashboard } : {}),
  };

  if (jsonOut) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(
      `🌊 Cortex Wave Factory | Legacy: ${manifest.summary.totalLegacy} -> Target: ${manifest.summary.estimatedTargetSpecs} (-${manifest.summary.reductionPct}%) | Wave-0 Prereqs: ${manifest.summary.wave0SharedPrereqs} | Queue(${selection.squad}/W${selection.wave}): ${selection.batch.length}/${selection.remainingInQueue}`
    );
    for (const item of selection.batch) {
      console.log(`  - ${item.id} (${item.className || item.squad || 'core'})`);
    }
    if (dashboard) console.log(`📊 Dashboard written -> ${dashboard.outPath}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try {
    main();
  } catch (err) {
    console.error(`❌ cortex wave: ${err.message}`);
    process.exit(1);
  }
}
