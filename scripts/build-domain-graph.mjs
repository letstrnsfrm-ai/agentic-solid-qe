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

const ROOT = process.cwd();
const DOMAIN_DIR = path.join(ROOT, '.agents/domain');
const GRAPH_OUT = path.join(DOMAIN_DIR, 'domain-graph.json');
const STALE_TTL_DAYS = Number(process.env.DOMAIN_STALE_DAYS || 90);

function walkFiles(dir, extFilter) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath, extFilter));
    } else if (!extFilter || fullPath.endsWith(extFilter)) {
      files.push(fullPath);
    }
  }
  return files;
}

function rel(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
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

function parseShardFile(filePath, squadId = 'global') {
  const content = fs.readFileSync(filePath, 'utf8');
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : path.basename(filePath, '.md');
  const routes = [...new Set([...content.matchAll(/`(\/[a-zA-Z0-9._/-]*)`/g)].map((m) => m[1]))];
  const provenance = parseProvenanceMetadata(content);
  const lines = content.split('\n').length;

  return {
    id: path.basename(filePath, '.md'),
    squad: squadId,
    path: rel(filePath),
    title,
    routes,
    lines,
    ownerSquad: provenance.ownerSquad,
    lastVerified: provenance.lastVerified,
    isStale: provenance.isStale,
    publishedCapabilities: provenance.publishedCapabilities,
  };
}

export function buildDomainGraph({ writeToDisk = true } = {}) {
  const domainMemoryPath = path.join(DOMAIN_DIR, 'domain-memory.md');
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
  const domainsRoot = path.join(DOMAIN_DIR, 'domains');
  const domainHubs = [];
  const allShards = [];

  if (fs.existsSync(domainsRoot)) {
    for (const entry of fs.readdirSync(domainsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const squadId = entry.name;
      const hubIndex = path.join(domainsRoot, squadId, 'index.md');
      const squadShardsDir = path.join(domainsRoot, squadId, 'shards');
      const squadShardFiles = walkFiles(squadShardsDir, '.md');
      const parsedSquadShards = squadShardFiles.map((f) => parseShardFile(f, squadId));
      allShards.push(...parsedSquadShards);

      if (fs.existsSync(hubIndex)) {
        const hubContent = fs.readFileSync(hubIndex, 'utf8');
        const titleMatch = hubContent.match(/^#\s+(.+)$/m);
        const provenance = parseProvenanceMetadata(hubContent);
        domainHubs.push({
          squad: squadId,
          hubPath: rel(hubIndex),
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
  const globalShardsDir = path.join(DOMAIN_DIR, 'shards');
  const globalShardFiles = walkFiles(globalShardsDir, '.md');
  for (const f of globalShardFiles) {
    allShards.push(parseShardFile(f, 'global'));
  }

  // 3. Build Route -> Shard Lookup Table for O(1) Agent Token Routing
  const routeIndex = {};
  for (const shard of allShards) {
    for (const route of shard.routes) {
      if (!routeIndex[route]) routeIndex[route] = [];
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

  if (writeToDisk && fs.existsSync(DOMAIN_DIR)) {
    fs.writeFileSync(GRAPH_OUT, JSON.stringify(graph, null, 2) + '\n', 'utf8');
  }

  return graph;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const graph = buildDomainGraph({ writeToDisk: true });
  console.log(
    `🧠 Compiled Federated Domain Graph -> .agents/domain/domain-graph.json (${graph.summary.totalDomainHubs} domain hub(s), ${graph.summary.totalShards} shard(s), ${Object.keys(graph.routeIndex).length} indexed route(s)).`
  );
}
