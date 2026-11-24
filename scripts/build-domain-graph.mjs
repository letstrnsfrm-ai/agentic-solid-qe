#!/usr/bin/env node
/**
 * Compiles the 3-Tier Federated Organizational Brain into a machine-readable router
 * (.agents/domain/domain-graph.json) and optional CODEOWNERS mapping.
 *
 * Tiers supported:
 *   Tier 0: .agents/domain/domain-memory.md (Org Root Index)
 *   Tier 1: .agents/domain/domains/<squad>/index.md (Domain / Squad Sub-Hub)
 *   Tier 2: .agents/domain/domains/<squad>/shards/<feature>.md & .agents/domain/shards/<feature>.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSystemMap } from './build-system-map.mjs';

const ROOT = process.cwd();
const DOMAIN_DIR = path.join(ROOT, '.agents/domain');
const GRAPH_OUT = path.join(DOMAIN_DIR, 'domain-graph.json');
const STALE_TTL_DAYS = Number(process.env.DOMAIN_STALE_DAYS || 90);

const MAX_SCAN_FILE_BYTES = 1024 * 1024; // 1 MB cap

function isWithinDir(targetPath, baseDir) {
  const relPath = path.relative(baseDir, targetPath);
  return relPath === '' || (!relPath.startsWith('..') && !path.isAbsolute(relPath));
}

function walkFiles(dir, extFilter) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath, extFilter));
    } else if (!extFilter || fullPath.endsWith(extFilter)) {
      try {
        const st = fs.lstatSync(fullPath);
        if (st.isFile() && st.size <= MAX_SCAN_FILE_BYTES) {
          files.push(fullPath);
        }
      } catch {
        /* skip unreadable file */
      }
    }
  }
  return files;
}

function relFrom(rootDir, filePath) {
  return path.relative(rootDir, filePath).replace(/\\/g, '/');
}

function parseProvenanceMetadata(content) {
  const ownerMatch =
    content.match(/\*\*Owner Squad:\*\*\s*`?([^`|\n]+)`?/i) ||
    content.match(/owner_squad:\s*([^\s|\n]+)/i);
  const verifiedMatch =
    content.match(/\*\*Last Verified:\*\*\s*`?(\d{4}-\d{2}-\d{2})`?/i) ||
    content.match(/last_verified:\s*(\d{4}-\d{2}-\d{2})/i);
  const capabilitiesMatch = content.match(/\*\*Published Capabilities:\*\*\s*(.+)/i);

  const lastVerified = verifiedMatch ? verifiedMatch[1].trim() : null;
  let isStale = false;
  if (lastVerified) {
    const ageMs = Date.now() - Date.parse(lastVerified);
    if (!Number.isNaN(ageMs) && ageMs > STALE_TTL_DAYS * 86400 * 1000) {
      isStale = true;
    }
  }

  return {
    ownerSquad: ownerMatch ? ownerMatch[1].trim() : '@org/unassigned',
    lastVerified,
    isStale,
    publishedCapabilities: capabilitiesMatch
      ? capabilitiesMatch[1]
          .split(',')
          .map((s) => s.trim().replace(/^`|`$/g, ''))
          .filter(Boolean)
      : [],
  };
}

function parseShardFile(filePath, squadId = 'global', rootDir = process.cwd()) {
  const content = fs.readFileSync(filePath, 'utf8');
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : path.basename(filePath, '.md');
  const routes = [...new Set([...content.matchAll(/`(\/[a-zA-Z0-9._:/{}-]*)`/g)].map((m) => m[1]))];
  const provenance = parseProvenanceMetadata(content);
  const lines = content.split('\n').length;

  return {
    id: path.basename(filePath, '.md'),
    squad: squadId,
    path: relFrom(rootDir, filePath),
    title,
    routes,
    lines,
    ownerSquad: provenance.ownerSquad,
    lastVerified: provenance.lastVerified,
    isStale: provenance.isStale,
    publishedCapabilities: provenance.publishedCapabilities,
  };
}

export function buildDomainGraph({ rootDir = process.cwd(), writeToDisk = true } = {}) {
  const domainDir = path.join(rootDir, '.agents/domain');
  const graphOut = path.join(domainDir, 'domain-graph.json');
  const domainMemoryPath = path.join(domainDir, 'domain-memory.md');
  let appName = 'Unknown';
  let baseUrl = 'http://localhost:3000';
  if (fs.existsSync(domainMemoryPath)) {
    const memContent = fs.readFileSync(domainMemoryPath, 'utf8');
    const nameMatch = memContent.match(/-\s*\*\*Application Name:\*\*\s*(.+)/);
    const urlMatch = memContent.match(/-\s*\*\*Base URL:\*\*\s*`([^`]+)`/);
    if (nameMatch) appName = nameMatch[1].trim();
    if (urlMatch) baseUrl = urlMatch[1].trim();
  }

  // 1. Scan Tier 1 Domain Sub-Hubs (.agents/domain/domains/<squad>/index.md)
  const domainsRoot = path.join(domainDir, 'domains');
  const domainHubs = [];
  const allShards = [];

  if (fs.existsSync(domainsRoot)) {
    for (const entry of fs.readdirSync(domainsRoot, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const squadId = entry.name;
      const hubIndex = path.join(domainsRoot, squadId, 'index.md');
      const squadShardsDir = path.join(domainsRoot, squadId, 'shards');
      const squadShardFiles = walkFiles(squadShardsDir, '.md');
      const parsedSquadShards = squadShardFiles.map((f) => parseShardFile(f, squadId, rootDir));
      allShards.push(...parsedSquadShards);

      if (fs.existsSync(hubIndex)) {
        const hubContent = fs.readFileSync(hubIndex, 'utf8');
        const titleMatch = hubContent.match(/^#\s+(.+)$/m);
        const provenance = parseProvenanceMetadata(hubContent);
        domainHubs.push({
          squad: squadId,
          hubPath: relFrom(rootDir, hubIndex),
          title: titleMatch ? titleMatch[1].trim() : squadId,
          lines: hubContent.split('\n').length,
          ownerSquad: provenance.ownerSquad,
          publishedCapabilities: provenance.publishedCapabilities,
          shardCount: parsedSquadShards.length,
          routes: [...new Set(parsedSquadShards.flatMap((s) => s.routes))],
        });
      }
    }
  }

  // 2. Scan Flat / Global Shards (.agents/domain/shards/*.md)
  const globalShardsDir = path.join(domainDir, 'shards');
  const globalShardFiles = walkFiles(globalShardsDir, '.md');
  for (const f of globalShardFiles) {
    allShards.push(parseShardFile(f, 'global', rootDir));
  }

  // 3. Build Route -> Shard Lookup Table for O(1) Agent Token Routing
  const routeIndex = Object.create(null);
  for (const shard of allShards) {
    for (const route of shard.routes) {
      if (!Object.hasOwn(routeIndex, route)) routeIndex[route] = [];
      routeIndex[route].push(shard.path);
    }
  }

  // 4. Build CODEOWNERS rules for Domain Brain & Scoped SOLID Modules
  const codeownersRules = domainHubs.map((hub) => ({
    pattern: `/.agents/domain/domains/${hub.squad}/`,
    owner: hub.ownerSquad,
  }));

  const graph = {
    schemaVersion: '2.0.0',
    architecture: '3-tier-federated-brain',
    targetApp: { appName, baseUrl },
    summary: {
      totalDomainHubs: domainHubs.length,
      totalShards: allShards.length,
      staleShards: allShards.filter((s) => s.isStale).map((s) => s.path),
    },
    domainHubs,
    shards: allShards,
    routeIndex,
    codeownersRules,
  };

  const isUnsafeWritePath = (targetPath) => {
    const resolvedRoot = path.resolve(rootDir);
    const resolvedTarget = path.resolve(targetPath);
    if (!isWithinDir(resolvedTarget, resolvedRoot)) return true;
    let cur = resolvedTarget;
    while (cur !== resolvedRoot) {
      try {
        if (fs.lstatSync(cur).isSymbolicLink()) return true;
      } catch (err) {
        if (err?.code !== 'ENOENT') return true;
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    return false;
  };

  if (writeToDisk && fs.existsSync(domainDir) && !isUnsafeWritePath(graphOut)) {
    fs.writeFileSync(graphOut, JSON.stringify(graph, null, 2) + '\n', 'utf8');
  }

  return graph;
}

export function seedShardsFromTapes({ rootDir = process.cwd() } = {}) {
  const domainDir = path.join(rootDir, '.agents/domain');
  const tapesDir = path.join(rootDir, '.exploratory/tapes');
  if (!fs.existsSync(tapesDir)) return [];

  const isUnsafeWritePath = (targetPath) => {
    const resolvedRoot = path.resolve(rootDir);
    const resolvedTarget = path.resolve(targetPath);
    if (!isWithinDir(resolvedTarget, resolvedRoot)) return true;
    let cur = resolvedTarget;
    while (cur !== resolvedRoot) {
      try {
        if (fs.lstatSync(cur).isSymbolicLink()) return true;
      } catch (err) {
        if (err?.code !== 'ENOENT') return true;
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    return false;
  };

  const existingGraph = buildDomainGraph({ rootDir, writeToDisk: false });
  const indexedRoutes = new Set(Object.keys(existingGraph.routeIndex));
  const domainMemoryPath = path.join(domainDir, 'domain-memory.md');

  const today = new Date().toISOString().slice(0, 10);
  const createdShards = [];

  for (const entry of fs.readdirSync(tapesDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith('.json')) continue;
    const tapeFullPath = path.join(tapesDir, entry.name);
    let tape;
    try {
      const stat = fs.lstatSync(tapeFullPath);
      if (stat.size > MAX_SCAN_FILE_BYTES) continue;
      tape = JSON.parse(fs.readFileSync(tapeFullPath, 'utf8'));
    } catch {
      continue;
    }
    if (!tape || typeof tape !== 'object' || Array.isArray(tape)) continue;
    const rawScenarioId = String(tape.scenarioId || path.basename(entry.name, '.json'));
    if (!/^[a-z0-9-]+$/.test(rawScenarioId) || rawScenarioId.includes('..')) {
      throw new Error(
        `Security Error: Invalid scenarioId '${rawScenarioId}' in '${entry.name}'. Must match ^[a-z0-9-]+$ with no path traversal.`
      );
    }
    const scenarioId = rawScenarioId;
    const steps = Array.isArray(tape.semanticSteps) ? tape.semanticSteps : [];

    // Match a Tier 1 Squad Hub if scenarioId or routes start with a known squad prefix
    const matchedHub = existingGraph.domainHubs.find(
      (h) =>
        scenarioId.startsWith(`${h.squad}-`) ||
        steps.some(
          (s) =>
            typeof s?.pageRoute === 'string' &&
            (s.pageRoute === `/${h.squad}` || s.pageRoute.startsWith(`/${h.squad}/`))
        )
    );

    const targetShardsDir = matchedHub
      ? path.join(domainDir, 'domains', matchedHub.squad, 'shards')
      : path.join(domainDir, 'shards');
    if (isUnsafeWritePath(targetShardsDir)) continue;
    fs.mkdirSync(targetShardsDir, { recursive: true });

    const shardPath = path.resolve(targetShardsDir, `${scenarioId}.md`);
    if (!isWithinDir(shardPath, targetShardsDir) || isUnsafeWritePath(shardPath) || fs.existsSync(shardPath)) continue;

    const routes = new Set();
    const components = new Set();
    for (const step of steps) {
      if (!step || typeof step !== 'object') continue;
      if (step.componentCandidate) components.add(step.componentCandidate);
      for (const candidate of [
        step.pageRoute,
        step.waitForUrl,
        step.action === 'goto' ? step.locatorContract?.value : null,
      ]) {
        if (typeof candidate === 'string' && candidate.startsWith('/') && !candidate.startsWith('//')) {
          routes.add(candidate.split('?')[0]);
        }
      }
    }
    const unindexed = [...routes].filter((r) => !indexedRoutes.has(r));
    if (unindexed.length === 0 && existingGraph.summary.totalShards + createdShards.length > 0) continue;

    const cleanInline = (val) =>
      String(val ?? '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069`]+/g, '')
        .trim();
    const routeList = (unindexed.length > 0 ? unindexed : [...routes].length > 0 ? [...routes] : ['/']).map(
      (r) => cleanInline(r) || '/'
    );
    const routeLines = routeList.map((r) => `- \`${r}\``).join('\n');
    const compLines = [...components].map((c) => `- \`${cleanInline(c)}\``).filter((l) => l !== '- ``').join('\n') || '- _TBD_';
    const apiLine = tape.apiBaseUrl ? `\n- **API Base URL:** \`${cleanInline(tape.apiBaseUrl)}\`` : '';
    const ownerSquad = cleanInline(matchedHub ? matchedHub.ownerSquad : '@org/unassigned') || '@org/unassigned';
    const safeTitle = cleanInline(tape.title || scenarioId) || scenarioId;

    const actorLines =
      Array.isArray(tape.actors) && tape.actors.length > 0
        ? `\n## Multi-Portal Actors\n` +
          tape.actors
            .map(
              (a) =>
                `- **${cleanInline(a.actorId)}** (\`${cleanInline(a.role)}\`): \`${cleanInline(a.portalBaseUrl)}\`${a.storageStatePath ? ` (\`${cleanInline(a.storageStatePath)}\`)` : ''}`
            )
            .join('\n') +
          '\n'
        : '';

    const networkLines =
      Array.isArray(tape.networkContracts) && tape.networkContracts.length > 0
        ? `\n## Observed Backend API Contracts\n` +
          tape.networkContracts
            .map(
              (nc) =>
                `- \`${cleanInline(nc.method)} ${cleanInline(nc.urlPattern)}\` (Expected: \`${cleanInline(nc.expectedStatus)}\`)${nc.clientCandidate ? ` -> \`${cleanInline(nc.clientCandidate)}\`` : ''}${nc.responseSchemaSummary ? ` — \`${cleanInline(nc.responseSchemaSummary)}\`` : ''}`
            )
            .join('\n') +
          '\n'
        : '';

    const content = `# Feature Shard: ${safeTitle}

- **Owner Squad:** \`${ownerSquad}\`
- **Last Verified:** \`${today}\`
- **Source Tape:** \`.exploratory/tapes/${entry.name}\`${apiLine}

## Routes
${routeLines}

## Component & API Client Candidates
${compLines}
${actorLines}${networkLines}`;

    fs.writeFileSync(shardPath, content, 'utf8');
    const shardRel = relFrom(rootDir, shardPath);
    createdShards.push(shardRel);
    for (const r of routeList) indexedRoutes.add(r);

    // Auto-index the newly seeded shard in Tier 1 Squad Hub or Tier 0 domain-memory.md
    const routeSummary = routeList.map((r) => `\`${r.replace(/\|/g, '-')}\``).join(', ');
    const summaryText = safeTitle.replace(/\|/g, '-').trim();
    if (matchedHub) {
      const hubIndexFile = path.join(rootDir, matchedHub.hubPath);
      if (!isUnsafeWritePath(hubIndexFile) && fs.existsSync(hubIndexFile)) {
        const hubContent = fs.readFileSync(hubIndexFile, 'utf8');
        if (!hubContent.includes(path.basename(shardPath))) {
          const row = `| **${summaryText}** | ${routeSummary} | \`${shardRel}\` | Auto-seeded from Session Tape |\n`;
          fs.appendFileSync(hubIndexFile, (hubContent.endsWith('\n') ? '' : '\n') + row, 'utf8');
        }
      }
    } else if (!isUnsafeWritePath(domainMemoryPath) && fs.existsSync(domainMemoryPath)) {
      const memContent = fs.readFileSync(domainMemoryPath, 'utf8');
      if (!memContent.includes(path.basename(shardPath))) {
        const row = `| **${summaryText}** | \`${ownerSquad}\` | ${routeSummary} | \`${shardRel}\` | Auto-seeded from \`${entry.name}\` |\n`;
        const tableMarker = '| :--- | :--- | :--- | :--- | :--- |';
        if (memContent.includes(tableMarker)) {
          const updatedMem = memContent.replace(tableMarker, () => `${tableMarker}\n${row.trimEnd()}`);
          fs.writeFileSync(domainMemoryPath, updatedMem, 'utf8');
        } else {
          fs.appendFileSync(domainMemoryPath, (memContent.endsWith('\n') ? '' : '\n') + row, 'utf8');
        }
      }
    }
  }

  return createdShards;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  const seedFromTapes = process.argv.includes('--seed-from-tapes');
  const skipMap = process.argv.includes('--skip-map');
  if (seedFromTapes) {
    const seeded = seedShardsFromTapes();
    if (seeded.length > 0) {
      console.log(`🌱 Seeded & indexed ${seeded.length} shard(s) from Session Tapes: ${seeded.join(', ')}`);
    } else {
      console.log('ℹ️  No new shards needed from Session Tapes.');
    }
  }
  const graph = buildDomainGraph({ writeToDisk: true });
  if (!skipMap) {
    try {
      buildSystemMap({ quiet: true });
    } catch {
      /* non-fatal if reports/ cannot be written */
    }
  }
  console.log(
    `🧠 Compiled Federated Domain Graph -> .agents/domain/domain-graph.json (${graph.summary.totalDomainHubs} domain hub(s), ${graph.summary.totalShards} shard(s), ${Object.keys(graph.routeIndex).length} indexed route(s)).`
  );
}
