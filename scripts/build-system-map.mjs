#!/usr/bin/env node
/**
 * Builds a self-contained, zero-dependency interactive HTML visualization
 * (reports/system-map.html) from acquired domain shards, Session Tapes,
 * SOLID TypeScript artifacts, test specs, and open defects.
 *
 * Security: Structural & schema-level data only (never raw tokens, cookies, or PII).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const DEFAULT_OUT = path.join(ROOT, 'reports', 'system-map.html');
const MAX_FILE_BYTES = 1024 * 1024;

function isWithinDir(targetPath, baseDir) {
  const relPath = path.relative(baseDir, targetPath);
  return relPath === '' || (!relPath.startsWith('..') && !path.isAbsolute(relPath));
}

function rel(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function walkFiles(dir, extFilter) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(full, extFilter));
    } else if (!extFilter || full.endsWith(extFilter)) {
      try {
        const st = fs.lstatSync(full);
        if (st.isFile() && st.size <= MAX_FILE_BYTES) files.push(full);
      } catch {
        /* skip unreadable */
      }
    }
  }
  return files;
}

function readDomainMemory() {
  const memPath = path.join(ROOT, '.agents/domain/domain-memory.md');
  if (!fs.existsSync(memPath)) {
    return { appName: 'Unknown App', baseUrl: '', sessionMechanism: '' };
  }
  const content = fs.readFileSync(memPath, 'utf8');
  const appName = content.match(/\*\*Application Name:\*\*\s*(.+)/i)?.[1]?.trim() || 'Target App';
  const baseUrl = content.match(/\*\*Base URL:\*\*\s*`?([^`\n]+)`?/i)?.[1]?.trim() || '';
  const sessionMechanism =
    content.match(/\*\*Session Mechanism:\*\*\s*(.+)/i)?.[1]?.trim() || '';
  return { appName, baseUrl, sessionMechanism };
}

function readShards() {
  const shardFiles = [
    ...walkFiles(path.join(ROOT, '.agents/domain/shards'), '.md'),
    ...walkFiles(path.join(ROOT, '.agents/domain/domains'), '.md').filter((f) =>
      f.includes(`${path.sep}shards${path.sep}`)
    ),
  ];
  return shardFiles.map((filePath) => {
    const content = fs.readFileSync(filePath, 'utf8');
    const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(filePath, '.md');
    const ownerSquad =
      content.match(/\*\*Owner Squad:\*\*\s*`?([^`|\n]+)`?/i)?.[1]?.trim() || '@org/unassigned';
    const lastVerified =
      content.match(/\*\*Last Verified:\*\*\s*`?(\d{4}-\d{2}-\d{2})`?/i)?.[1]?.trim() || null;
    const capRaw = content.match(/\*\*Published Capabilities:\*\*\s*(.+)/i)?.[1] || '';
    const capabilities = capRaw.includes('none yet')
      ? []
      : capRaw
          .split(',')
          .map((s) => s.trim().replace(/^`|`$/g, ''))
          .filter(Boolean);
    const routes = [...new Set([...content.matchAll(/`(\/[a-zA-Z0-9._/-]*)`/g)].map((m) => m[1]))];
    const relFile = rel(filePath);
    return { id: relFile, file: relFile, title, ownerSquad, lastVerified, capabilities, routes };
  });
}

function readTapes() {
  const tapeFiles = walkFiles(path.join(ROOT, '.exploratory/tapes'), '.json');
  const tapes = [];
  for (const filePath of tapeFiles) {
    try {
      const t = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const contracts = (t.networkContracts || []).map((nc) => ({
        method: nc.method || 'GET',
        urlPattern: nc.urlPattern || '',
        expectedStatus: nc.expectedStatus || 200,
        clientCandidate: nc.clientCandidate || null,
        responseSchemaSummary: nc.responseSchemaSummary || '',
      }));

      // Group semanticSteps + expectedStates by businessStep
      const stepGroups = [];
      const groupByTitle = new Map();
      for (const s of t.semanticSteps || []) {
        const title = s.businessStep || s.intent || `Step ${s.stepIndex}`;
        if (!groupByTitle.has(title)) {
          const g = {
            title,
            pageRoute: s.pageRoute || '',
            actions: [],
            components: new Set(),
            apis: [],
            outcomes: [],
          };
          groupByTitle.set(title, g);
          stepGroups.push(g);
        }
        const g = groupByTitle.get(title);
        g.actions.push({
          stepIndex: s.stepIndex,
          action: s.action,
          intent: s.intent,
          component: s.componentCandidate,
          inputDataRef: s.inputDataRef || null,
          waitForNetwork: s.waitForNetwork || null,
        });
        if (s.componentCandidate) g.components.add(s.componentCandidate);
        if (typeof s.waitForNetwork === 'string' && s.waitForNetwork.trim()) {
          const waitStr = s.waitForNetwork.trim();
          const waitNeedle = waitStr.replace(/\*/g, '');
          const matched = contracts.filter((c) => {
            if (!c.urlPattern) return false;
            if (c.urlPattern === waitStr) return true;
            const patNeedle = c.urlPattern.replace(/\*/g, '');
            return (
              (waitNeedle.length > 0 && c.urlPattern.includes(waitNeedle)) ||
              (patNeedle.length > 0 && waitStr.includes(patNeedle))
            );
          });
          for (const m of matched) {
            if (!g.apis.some((a) => a.method === m.method && a.urlPattern === m.urlPattern)) {
              g.apis.push(m);
            }
          }
        }
      }

      for (const es of t.expectedStates || []) {
        const title = es.businessStep || 'Verify expected business outcomes';
        if (!groupByTitle.has(title)) {
          const g = {
            title,
            pageRoute: '',
            actions: [],
            components: new Set(),
            apis: [],
            outcomes: [],
          };
          groupByTitle.set(title, g);
          stepGroups.push(g);
        }
        groupByTitle.get(title).outcomes.push({
          description: es.description,
          assertionType: es.assertionType,
          targetComponent: es.targetComponent,
          targetProperty: es.targetProperty,
        });
      }

      tapes.push({
        scenarioId: t.scenarioId || path.basename(filePath, '.json'),
        title: t.title || path.basename(filePath, '.json'),
        charter: t.charter || 'happy-path-baseline',
        tags: t.tags || [],
        personaRole: t.persona?.role || 'standard',
        dataBuilderRef: t.persona?.dataBuilderRef || '',
        networkContracts: contracts,
        businessSteps: stepGroups.map((g) => ({
          title: g.title,
          pageRoute: g.pageRoute,
          actions: g.actions,
          components: [...g.components],
          apis: g.apis,
          outcomes: g.outcomes,
        })),
      });
    } catch {
      /* skip malformed tape */
    }
  }
  return tapes;
}

function readSpecs() {
  const specFiles = walkFiles(path.join(ROOT, 'tests'), '.spec.ts');
  return specFiles.map((filePath) => {
    const content = fs.readFileSync(filePath, 'utf8');
    const tags = [...new Set([...content.matchAll(/@[a-z0-9-]+/g)].map((m) => m[0]))];
    const tests = [...content.matchAll(/test\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
    const tapeMatch = content.match(/Compiled from Session Tape:\s*([a-z0-9-]+)/i);
    return {
      file: rel(filePath),
      tags,
      tests,
      scenarioId: tapeMatch ? tapeMatch[1] : null,
    };
  });
}

function readDefects() {
  const defectFiles = walkFiles(path.join(ROOT, 'defects'), '.md').filter(
    (f) => path.basename(f).toLowerCase() !== 'readme.md'
  );
  return defectFiles.map((filePath) => {
    const content = fs.readFileSync(filePath, 'utf8');
    const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(filePath, '.md');
    const severity = content.match(/\*\*Severity:\*\*\s*([^\n]+)/i)?.[1]?.trim() || 'Unknown';
    const endpoint = content.match(/\*\*Endpoint:\*\*\s*`?([^`\n]+)`?/i)?.[1]?.trim() || '';
    const route = content.match(/\*\*Route \/ Portal:\*\*\s*([^\n]+)/i)?.[1]?.trim() || '';
    return { file: rel(filePath), title, severity, endpoint, route };
  });
}

function readSrcInventory() {
  const srcDir = path.join(ROOT, 'src');
  const tsFiles = walkFiles(srcDir, '.ts');
  const layers = { pages: [], steps: [], components: [], apiClients: [], seeders: [], builders: [] };
  for (const f of tsFiles) {
    const r = rel(f);
    const content = fs.readFileSync(f, 'utf8');
    const classMatch = content.match(/export\s+class\s+([A-Za-z0-9_]+)/);
    const name = classMatch ? classMatch[1] : path.basename(f, '.ts');
    const item = { name, file: r };
    if (r.endsWith('.step.ts') || r.includes('/steps/')) layers.steps.push(item);
    else if (r.endsWith('.page.ts') || r.includes('/pages/')) layers.pages.push(item);
    else if (r.endsWith('.component.ts') || r.includes('/components/')) layers.components.push(item);
    else if (r.endsWith('.client.ts')) layers.apiClients.push(item);
    else if (r.endsWith('.seeder.ts')) layers.seeders.push(item);
    else if (r.endsWith('.builder.ts')) layers.builders.push(item);
  }
  return layers;
}

export function collectSystemKnowledge() {
  const env = readDomainMemory();
  const shards = readShards();
  const tapes = readTapes();
  const specs = readSpecs();
  const defects = readDefects();
  const src = readSrcInventory();

  // Compute shard coverage
  const compiledTapeIds = new Set(specs.map((s) => s.scenarioId).filter(Boolean));
  const shardCoverage = shards.map((sh) => {
    const shRoutes = Array.isArray(sh.routes) ? sh.routes.map((r) => String(r).toLowerCase()) : [];
    const matchedTapes = tapes.filter((t) => {
      const tapeRoutes = (Array.isArray(t.businessSteps) ? t.businessSteps : [])
        .map((s) => String(s.pageRoute || '').toLowerCase())
        .filter(Boolean);
      const routeMatched =
        shRoutes.length > 0 &&
        tapeRoutes.some((tr) =>
          shRoutes.some((sr) => (sr === '/' || tr === '/' ? sr === tr : tr.includes(sr) || sr.includes(tr)))
        );
      return (
        routeMatched ||
        sh.capabilities.some((c) => JSON.stringify(t).includes(c)) ||
        (sh.file.includes('auth') && t.scenarioId.includes('auth')) ||
        (sh.file.includes('direct') && t.scenarioId.includes('direct')) ||
        (sh.file.includes('aggregator') && t.scenarioId.includes('aggregator'))
      );
    });
    const isCovered = matchedTapes.some((t) => compiledTapeIds.has(t.scenarioId));
    return {
      ...sh,
      isCovered,
      scenarios: matchedTapes.map((t) => t.scenarioId),
    };
  });

  // Deduplicate API endpoints across tapes
  const apiMap = new Map();
  for (const t of tapes) {
    for (const nc of t.networkContracts) {
      const key = `${nc.method} ${nc.urlPattern}`;
      if (!apiMap.has(key)) {
        apiMap.set(key, {
          ...nc,
          scenarios: [t.scenarioId],
        });
      } else {
        apiMap.get(key).scenarios.push(t.scenarioId);
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    env,
    shards: shardCoverage,
    tapes,
    specs,
    defects,
    src,
    apis: [...apiMap.values()],
  };
}

function renderHtml(model) {
  const safeJson = JSON.stringify(model)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Agentic-SOLID-QE — Acquired System &amp; Business Flow Map</title>
<style>
  :root {
    --bg: #0b1020; --panel: #121a2f; --panel-2: #18223d; --border: #263354;
    --text: #e6ecf8; --muted: #94a3b8; --accent: #38bdf8; --green: #34d399;
    --amber: #fbbf24; --red: #f87171; --purple: #a78bfa;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.45; }
  header { padding: 18px 28px; border-bottom: 1px solid var(--border); background: var(--panel); display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; }
  header h1 { margin: 0; font-size: 18px; font-weight: 700; }
  .subtitle { font-size: 13px; color: var(--muted); }
  .pill { display: inline-block; padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 600; background: var(--panel-2); border: 1px solid var(--border); color: var(--accent); }
  .pill.green { color: var(--green); border-color: rgba(52,211,153,.35); }
  .pill.red { color: var(--red); border-color: rgba(248,113,113,.35); }
  .pill.amber { color: var(--amber); border-color: rgba(251,191,36,.35); }
  .pill.purple { color: var(--purple); border-color: rgba(167,139,250,.35); }
  main { padding: 22px 28px; max-width: 1400px; margin: 0 auto; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .kpi { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .kpi .val { font-size: 24px; font-weight: 700; color: var(--accent); }
  .kpi .lbl { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .tabs { display: flex; gap: 8px; margin-bottom: 18px; border-bottom: 1px solid var(--border); padding-bottom: 10px; }
  .tab-btn { background: var(--panel); color: var(--muted); border: 1px solid var(--border); padding: 8px 16px; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 13px; }
  .tab-btn.active { background: var(--accent); color: #06121e; border-color: var(--accent); }
  .view { display: none; }
  .view.active { display: block; }
  .flow-grid { display: grid; grid-template-columns: 280px 1fr; gap: 18px; }
  @media (max-width: 900px) { .flow-grid { grid-template-columns: 1fr; } }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 14px; }
  .flow-item { padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--panel-2); margin-bottom: 8px; cursor: pointer; }
  .flow-item.active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .seq-step { border: 1px solid var(--border); border-radius: 10px; background: var(--panel-2); padding: 14px; margin-bottom: 12px; }
  .seq-row { display: grid; grid-template-columns: 1.2fr 1fr 1.3fr 1fr; gap: 10px; align-items: start; margin-top: 10px; }
  @media (max-width: 900px) { .seq-row { grid-template-columns: 1fr; } }
  .lane { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 10px; font-size: 12px; }
  .lane h4 { margin: 0 0 6px 0; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  .api-badge { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; padding: 4px 6px; background: rgba(56,189,248,.1); border: 1px solid rgba(56,189,248,.3); border-radius: 6px; margin-bottom: 6px; display: block; word-break: break-all; }
  .schema { font-family: ui-monospace, monospace; font-size: 11px; color: var(--muted); }
  .topo-wrap { overflow-x: auto; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
  svg text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: var(--text); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-size: 11px; text-transform: uppercase; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--accent); }
</style>
</head>
<body>
<header>
  <div>
    <h1 id="app-title">Agentic-SOLID-QE System Map</h1>
    <div class="subtitle" id="app-meta"></div>
  </div>
  <div id="generated-at" class="pill"></div>
</header>
<main>
  <div class="kpis" id="kpis"></div>
  <div class="tabs">
    <button class="tab-btn active" data-tab="flows">Business Flows &amp; API Sequence</button>
    <button class="tab-btn" data-tab="topology">System Topology Graph</button>
    <button class="tab-btn" data-tab="coverage">Coverage &amp; Defect Overlay</button>
  </div>
  <section id="view-flows" class="view active">
    <div class="flow-grid">
      <div class="card">
        <h3 style="margin-top:0;font-size:14px;">Discovered Business Flows</h3>
        <div id="flow-list"></div>
      </div>
      <div class="card" id="flow-detail"></div>
    </div>
  </section>
  <section id="view-topology" class="view">
    <div class="topo-wrap" id="topo-svg"></div>
  </section>
  <section id="view-coverage" class="view">
    <div class="card">
      <h3 style="margin-top:0;font-size:14px;">Domain Shards &amp; Test Coverage</h3>
      <table id="shard-table"></table>
    </div>
    <div class="card">
      <h3 style="margin-top:0;font-size:14px;">Open Defects (DEFECT-*.md)</h3>
      <div id="defect-list"></div>
    </div>
  </section>
</main>
<script>
const MODEL = ${safeJson};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

document.getElementById('app-title').textContent = MODEL.env.appName + ' — System & Business Flow Map';
document.getElementById('app-meta').textContent = (MODEL.env.baseUrl || 'No baseUrl') + (MODEL.env.sessionMechanism ? '  |  Session: ' + MODEL.env.sessionMechanism : '');
document.getElementById('generated-at').textContent = 'Refreshed ' + new Date(MODEL.generatedAt).toLocaleString();

const kpis = [
  { val: MODEL.shards.length, lbl: 'Domain Shards' },
  { val: MODEL.tapes.length, lbl: 'Business Flows (Tapes)' },
  { val: MODEL.apis.length, lbl: 'Backend API Contracts' },
  { val: MODEL.src.components.length + MODEL.src.steps.length, lbl: 'SOLID Components & Steps' },
  { val: (MODEL.src.seeders || []).length, lbl: 'State Seeders' },
  { val: MODEL.specs.length, lbl: 'Automated Spec Files' },
  { val: MODEL.defects.length, lbl: 'Open Defects' },
];
document.getElementById('kpis').innerHTML = kpis.map(k => '<div class="kpi"><div class="val">' + k.val + '</div><div class="lbl">' + esc(k.lbl) + '</div></div>').join('');

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('view-' + btn.dataset.tab).classList.add('active');
  });
});

let selectedTape = 0;
function renderFlows() {
  const list = document.getElementById('flow-list');
  const detail = document.getElementById('flow-detail');
  if (!MODEL.tapes.length) {
    list.innerHTML = '<div class="subtitle">No Session Tapes recorded yet. Run /01-cli-explorer to map a flow.</div>';
    detail.innerHTML = '';
    return;
  }
  list.innerHTML = MODEL.tapes.map((t, i) =>
    '<div class="flow-item ' + (i === selectedTape ? 'active' : '') + '" data-idx="' + i + '">' +
    '<div style="font-weight:600;font-size:13px;">' + esc(t.title) + '</div>' +
    '<div style="margin-top:5px;display:flex;gap:5px;flex-wrap:wrap;">' +
    '<span class="pill">' + esc(t.charter) + '</span>' +
    t.tags.map(tg => '<span class="pill green">' + esc(tg) + '</span>').join('') +
    '</div></div>'
  ).join('');
  list.querySelectorAll('.flow-item').forEach(el => {
    el.addEventListener('click', () => { selectedTape = Number(el.dataset.idx); renderFlows(); });
  });

  const t = MODEL.tapes[selectedTape];
  detail.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:12px;">' +
    '<div><h3 style="margin:0;font-size:16px;">' + esc(t.title) + '</h3>' +
    '<div class="subtitle">Scenario: <code>' + esc(t.scenarioId) + '</code> | Persona: <code>' + esc(t.personaRole) + '</code> | Builder: <code>' + esc(t.dataBuilderRef) + '</code></div></div>' +
    '<div>' + t.tags.map(tg => '<span class="pill green" style="margin-left:4px;">' + esc(tg) + '</span>').join('') + '</div></div>' +
    t.businessSteps.map((s, idx) =>
      '<div class="seq-step">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;"><strong>' + (idx + 1) + '. ' + esc(s.title) + '</strong><span class="pill">' + esc(s.pageRoute) + '</span></div>' +
      '<div class="seq-row">' +
        '<div class="lane"><h4>User Interaction</h4>' + (s.actions.length ? s.actions.map(a => '<div><code>' + esc(a.action) + '</code> ' + esc(a.intent) + '</div>').join('') : '<span class="subtitle">Assertion step</span>') + '</div>' +
        '<div class="lane"><h4>UI Components</h4>' + (s.components.length ? s.components.map(c => '<div><code>' + esc(c) + '</code></div>').join('') : '<span class="subtitle">—</span>') + '</div>' +
        '<div class="lane"><h4>Backend API Calls</h4>' + (s.apis.length ? s.apis.map(api => '<span class="api-badge">' + esc(api.method) + ' ' + esc(api.urlPattern) + ' → ' + esc(api.expectedStatus) + '</span><div class="schema">' + esc(api.responseSchemaSummary) + '</div>').join('') : '<span class="subtitle">Client-side transition</span>') + '</div>' +
        '<div class="lane"><h4>Expected Outcome</h4>' + (s.outcomes.length ? s.outcomes.map(o => '<div><code>' + esc(o.assertionType) + '</code> ' + esc(o.description) + '</div>').join('') : '<span class="subtitle">Advances flow</span>') + '</div>' +
      '</div></div>'
    ).join('');
}

function renderTopology() {
  const cols = [
    { title: 'Domain Shards', items: MODEL.shards.map(s => ({ label: s.title.replace('Domain Shard: ', ''), sub: s.ownerSquad, color: s.isCovered ? '#34d399' : '#fbbf24' })) },
    { title: 'Pages & Steps', items: [...MODEL.src.pages, ...MODEL.src.steps].map(p => ({ label: p.name, sub: p.file, color: '#38bdf8' })) },
    { title: 'Components', items: MODEL.src.components.map(c => ({ label: c.name, sub: c.file, color: '#a78bfa' })) },
    { title: 'State Seeders', items: (MODEL.src.seeders || []).map(sd => ({ label: sd.name, sub: sd.file, color: '#34d399' })) },
    { title: 'Backend APIs', items: MODEL.apis.map(a => ({ label: a.method + ' ' + a.urlPattern.replace('**', ''), sub: 'HTTP ' + a.expectedStatus + (a.clientCandidate ? ' (' + a.clientCandidate + ')' : ''), color: '#38bdf8' })) },
  ];
  const colW = 280, gap = 45, boxH = 46, padY = 14;
  const maxRows = Math.max(1, ...cols.map(c => c.items.length));
  const svgW = cols.length * (colW + gap) + 40;
  const svgH = Math.max(260, maxRows * (boxH + padY) + 70);

  let svg = '<svg width="' + svgW + '" height="' + svgH + '" viewBox="0 0 ' + svgW + ' ' + svgH + '">';
  cols.forEach((col, ci) => {
    const x = 20 + ci * (colW + gap);
    svg += '<text x="' + x + '" y="24" font-size="12" font-weight="700" fill="#94a3b8">' + esc(col.title.toUpperCase()) + '</text>';
    col.items.forEach((item, ri) => {
      const y = 44 + ri * (boxH + padY);
      svg += '<rect x="' + x + '" y="' + y + '" width="' + colW + '" height="' + boxH + '" rx="8" fill="#18223d" stroke="' + item.color + '" stroke-width="1.4" />';
      svg += '<text x="' + (x + 10) + '" y="' + (y + 19) + '" font-size="12" font-weight="600">' + esc(item.label.slice(0, 34)) + '</text>';
      svg += '<text x="' + (x + 10) + '" y="' + (y + 35) + '" font-size="10" fill="#94a3b8">' + esc(item.sub.slice(0, 42)) + '</text>';
    });
  });
  svg += '</svg>';
  document.getElementById('topo-svg').innerHTML = svg;
}

function renderCoverage() {
  document.getElementById('shard-table').innerHTML =
    '<thead><tr><th>Shard</th><th>Owner</th><th>Routes</th><th>Status</th><th>Last Verified</th></tr></thead><tbody>' +
    MODEL.shards.map(s =>
      '<tr><td><strong>' + esc(s.title) + '</strong><br/><code>' + esc(s.file) + '</code></td>' +
      '<td>' + esc(s.ownerSquad) + '</td>' +
      '<td>' + s.routes.map(r => '<code>' + esc(r) + '</code>').join(' ') + '</td>' +
      '<td>' + (s.isCovered ? '<span class="pill green">Covered</span>' : '<span class="pill amber">Uncovered</span>') + '</td>' +
      '<td>' + esc(s.lastVerified || '—') + '</td></tr>'
    ).join('') + '</tbody>';

  const dList = document.getElementById('defect-list');
  dList.innerHTML = MODEL.defects.length
    ? MODEL.defects.map(d =>
        '<div class="flow-item"><span class="pill red">' + esc(d.severity) + '</span> <strong>' + esc(d.title) + '</strong>' +
        '<div class="subtitle" style="margin-top:4px;">' + esc(d.route) + (d.endpoint ? ' | <code>' + esc(d.endpoint) + '</code>' : '') + '</div></div>'
      ).join('')
    : '<div class="subtitle">No open defects logged in defects/.</div>';
}

renderFlows();
renderTopology();
renderCoverage();
</script>
</body>
</html>`;
}

export function buildSystemMap({ outPath = DEFAULT_OUT, quiet = false, jsonOnly = false } = {}) {
  const resolvedRoot = path.resolve(ROOT);
  const resolvedOut = path.resolve(resolvedRoot, outPath);
  if (!isWithinDir(resolvedOut, resolvedRoot)) {
    throw new Error(`Security Error: Refusing to write outside workspace: ${outPath}`);
  }
  let cur = resolvedOut;
  while (cur !== resolvedRoot) {
    try {
      if (fs.lstatSync(cur).isSymbolicLink()) {
        throw new Error(
          `Security Error: Refusing to write system map through symbolic link: ${path.relative(resolvedRoot, cur)}`
        );
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  const model = collectSystemKnowledge();
  if (jsonOnly) {
    if (!quiet) console.log(JSON.stringify(model, null, 2));
    return { model, outPath: resolvedOut };
  }
  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
  fs.writeFileSync(resolvedOut, renderHtml(model), 'utf8');
  if (!quiet) {
    console.log(
      `🗺️  Generated Interactive System Map -> ${rel(resolvedOut)} (${model.shards.length} shard(s), ${model.tapes.length} flow(s), ${model.apis.length} API(s), ${model.defects.length} defect(s)).`
    );
  }
  return { model, outPath: resolvedOut };
}

const isMain =
  Boolean(process.argv[1]) &&
  fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outPath = outIdx !== -1 && args[outIdx + 1] ? args[outIdx + 1] : DEFAULT_OUT;
  const jsonOnly = args.includes('--json');
  buildSystemMap({ outPath, jsonOnly });
}
