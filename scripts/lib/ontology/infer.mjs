/**
 * Operational QE Ontology — Starter Ontology Inference & Safe Seeding.
 * Zero external runtime dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  ID_REGEX,
  KEBAB_REGEX,
  ONTOLOGY_REL_PATH,
  STATE_REGEX,
  VALID_HTTP_METHODS,
  collectSrcClassNames,
  isSafeWorkspaceFile,
  isWithinDir,
  loadOntology,
  walkFiles,
} from './core.mjs';
import { validateOntology } from './validate.mjs';

function toPascalCase(raw) {
  return String(raw || '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

function toCamelCase(raw) {
  const pascal = toPascalCase(raw);
  return pascal ? pascal.charAt(0).toLowerCase() + pascal.slice(1) : 'executeFlow';
}

function toKebabCase(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'target-domain';
}

/**
 * Infers a schema-valid starter Operational QE Ontology from existing domain shards,
 * Session Tapes, and SOLID `src/` modules.
 */
export function inferStarterOntology(rootDir = process.cwd()) {
  const today = new Date().toISOString().slice(0, 10);
  const srcClasses = collectSrcClassNames(rootDir);

  let domainSlug = 'target-app';
  let appTitle = 'Target Application';
  const memPath = path.join(rootDir, '.agents/domain/domain-memory.md');
  if (fs.existsSync(memPath) && isSafeWorkspaceFile(rootDir, memPath)) {
    const mem = fs.readFileSync(memPath, 'utf8');
    const nameMatch = mem.match(/\*\*Application Name:\*\*\s*(.+)/i) || mem.match(/\*\*App Name:\*\*\s*(.+)/i);
    if (nameMatch) {
      appTitle = nameMatch[1].trim();
      domainSlug = toKebabCase(appTitle.replace(/\([^)]*\)/g, ''));
    }
  }

  const shardFiles = [
    ...walkFiles(path.join(rootDir, '.agents/domain/shards'), '.md'),
    ...walkFiles(path.join(rootDir, '.agents/domain/domains'), '.md').filter((f) =>
      f.includes(`${path.sep}shards${path.sep}`)
    ),
  ];
  const shards = shardFiles.map((f) => {
    const content = fs.readFileSync(f, 'utf8');
    const id = path.basename(f, '.md');
    const routes = [...new Set([...content.matchAll(/`(\/[a-zA-Z0-9._:/{}-]*)`/g)].map((m) => m[1]))];
    const ownerMatch = content.match(/\*\*Owner Squad:\*\*\s*`?(@[a-z0-9-]+\/[a-z0-9-]+)`?/i);
    const capMatch = content.match(/\*\*Published Capabilities:\*\*\s*(.+)/i);
    const capabilities = capMatch
      ? capMatch[1].split(',').map((s) => s.trim().replace(/^`|`$/g, '')).filter(Boolean)
      : [];
    return { id, ownerSquad: ownerMatch ? ownerMatch[1] : '@org/qe-squad', routes, capabilities };
  });

  const entityMap = new Map();
  const builderClasses = Object.entries(srcClasses)
    .filter(([name, rel]) => name.endsWith('Builder') && !/Nfr|Budget/i.test(name) && rel.includes('/data/'))
    .map(([name]) => name);

  for (const bName of builderClasses) {
    const entId = bName.replace(/Builder$/, '') || bName;
    if (!ID_REGEX.test(entId)) continue;
    const matchedShard = shards.find(
      (s) => s.capabilities.includes(bName) || s.id.toLowerCase().includes(entId.toLowerCase())
    );
    const matchingComps = Object.keys(srcClasses).filter(
      (c) =>
        (c.endsWith('Page') || c.endsWith('Component')) &&
        (c.toLowerCase().startsWith(entId.toLowerCase()) || matchedShard?.capabilities.includes(c))
    );
    entityMap.set(entId, {
      id: entId,
      name: entId,
      description: `Inferred domain entity for ${entId} (review & refine states/properties).`,
      ownerSquad: matchedShard?.ownerSquad || '@org/qe-squad',
      states: ['initial', 'active'],
      transitions: [],
      properties: [],
      routes: matchedShard ? [...matchedShard.routes] : ['/'],
      components: [...new Set(matchingComps)],
      dataBuilders: [bName],
    });
  }

  if (entityMap.size === 0) {
    for (const sh of shards) {
      const entId = toPascalCase(sh.id) || 'Feature';
      if (!ID_REGEX.test(entId) || entityMap.has(entId)) continue;
      const validComps = sh.capabilities.filter((c) => Object.hasOwn(srcClasses, c) && !c.endsWith('Builder'));
      const validBuilders = sh.capabilities.filter((c) => Object.hasOwn(srcClasses, c) && c.endsWith('Builder'));
      entityMap.set(entId, {
        id: entId,
        name: entId,
        description: `Inferred domain entity from shard '${sh.id}'.`,
        ownerSquad: sh.ownerSquad,
        states: ['initial', 'active'],
        transitions: [],
        properties: [],
        routes: sh.routes.length > 0 ? [...sh.routes] : ['/'],
        components: validComps,
        dataBuilders: validBuilders,
      });
    }
  }

  if (entityMap.size === 0) {
    entityMap.set('Application', {
      id: 'Application',
      name: appTitle,
      description: 'Root application entity placeholder (expand with domain entities).',
      ownerSquad: '@org/qe-squad',
      states: ['initial', 'active'],
      transitions: [],
      properties: [],
      routes: ['/'],
      components: [],
      dataBuilders: [],
    });
  }

  const actions = [];
  const invariants = [];
  const actionIds = new Set();
  const invIds = new Set();
  const entityIds = [...entityMap.keys()];
  const tapeFiles = walkFiles(path.join(rootDir, '.exploratory/tapes'), '.json');

  for (const tf of tapeFiles) {
    let tape;
    try {
      tape = JSON.parse(fs.readFileSync(tf, 'utf8'));
    } catch {
      continue;
    }
    if (!tape || typeof tape !== 'object' || Array.isArray(tape)) continue;
    const scenarioId = toKebabCase(tape.scenarioId || path.basename(tf, '.json'));
    const actId = toCamelCase(scenarioId);
    if (!ID_REGEX.test(actId) || actionIds.has(actId)) continue;
    actionIds.add(actId);

    const stepComps = [
      ...new Set(
        (Array.isArray(tape.semanticSteps) ? tape.semanticSteps : [])
          .map((s) => s?.componentCandidate)
          .filter((c) => c && Object.hasOwn(srcClasses, c))
      ),
    ];
    const stepRoutes = [
      ...new Set(
        (Array.isArray(tape.semanticSteps) ? tape.semanticSteps : [])
          .map((s) => s?.pageRoute || (s?.action === 'goto' ? s?.locatorContract?.value : null))
          .filter((r) => typeof r === 'string' && r.startsWith('/') && !r.startsWith('//'))
      ),
    ];

    const targetEntId =
      entityIds.find((eid) => scenarioId.includes(eid.toLowerCase())) ||
      entityIds.find((eid) => stepComps.some((c) => entityMap.get(eid).components.includes(c))) ||
      entityIds[0];

    const apiEndpoints = (Array.isArray(tape.networkContracts) ? tape.networkContracts : [])
      .filter((nc) => nc && VALID_HTTP_METHODS.has(nc.method) && typeof nc.urlPattern === 'string' && nc.urlPattern.trim())
      .map((nc) => ({ method: nc.method, pathPattern: nc.urlPattern.trim() }));

    const personaRole = typeof tape.persona?.role === 'string' && STATE_REGEX.test(tape.persona.role)
      ? [tape.persona.role]
      : ['standard'];

    actions.push({
      id: actId,
      name: String(tape.title || actId).slice(0, 100),
      actorPersonas: personaRole,
      targetEntity: targetEntId,
      fromState: 'initial',
      toState: 'active',
      routes: stepRoutes.length > 0 ? stepRoutes : entityMap.get(targetEntId).routes,
      apiEndpoints,
      components: stepComps,
    });

    const targetEnt = entityMap.get(targetEntId);
    if (!targetEnt.transitions.some((t) => t.from === 'initial' && t.to === 'active' && t.viaAction === actId)) {
      targetEnt.transitions.push({ from: 'initial', to: 'active', viaAction: actId });
    }

    const invId = `inv-${scenarioId}`;
    if (KEBAB_REGEX.test(invId) && !invIds.has(invId)) {
      invIds.add(invId);
      const firstOracle = Array.isArray(tape.expectedStates) && tape.expectedStates[0]?.description
        ? tape.expectedStates[0].description
        : tape.title || `Verify ${scenarioId}`;
      const isP0 = Array.isArray(tape.tags) && tape.tags.includes('@p0');
      invariants.push({
        id: invId,
        description: String(firstOracle).length >= 5 ? String(firstOracle) : `Verify ${scenarioId}`,
        severity: isP0 ? 'p0' : 'p1',
        entity: targetEntId,
        action: actId,
        personas: personaRole,
        enforcedBy: {
          routes: stepRoutes.length > 0 ? stepRoutes : targetEnt.routes,
          components: stepComps,
        },
      });
    }
  }

  const links = [];
  const linkSeen = new Set();
  for (let i = 0; i < entityIds.length; i++) {
    for (let j = i + 1; j < entityIds.length; j++) {
      const a = entityMap.get(entityIds[i]);
      const b = entityMap.get(entityIds[j]);
      if (a.routes.some((r) => b.routes.includes(r))) {
        const lid = toKebabCase(`${a.id}-references-${b.id}`);
        if (!linkSeen.has(lid)) {
          linkSeen.add(lid);
          links.push({ id: lid, from: a.id, relation: 'references', to: b.id, cardinality: '1:N' });
        }
      }
    }
  }

  return {
    schemaVersion: '1.0.0',
    domain: domainSlug,
    description: `Auto-inferred Operational QE Ontology for ${appTitle} (review and refine states, links, and invariants).`,
    lastVerified: today,
    entities: [...entityMap.values()],
    links,
    actions,
    invariants,
  };
}

/**
 * Seeds `.agents/domain/ontology.json` from inferred domain artifacts.
 * Refuses to overwrite existing files without `force: true` and never writes an invalid ontology to disk.
 */
export function seedOntologyFile(
  rootDir = process.cwd(),
  { dryRun = false, force = false, ontologyOverride = null } = {}
) {
  const outPath = path.join(rootDir, ONTOLOGY_REL_PATH);
  const exists = fs.existsSync(outPath);
  if (exists && !force && !dryRun) {
    return {
      written: false,
      alreadyExists: true,
      path: ONTOLOGY_REL_PATH,
      valid: true,
      errors: [],
      ontology: loadOntology(rootDir).ontology,
    };
  }
  const inferred = ontologyOverride || inferStarterOntology(rootDir);
  const validation = validateOntology(inferred, { rootDir, checkSrcSymbols: true });
  const shouldWrite = !dryRun && validation.valid;
  if (shouldWrite) {
    const resolvedRoot = path.resolve(rootDir);
    const resolvedOut = path.resolve(outPath);
    if (!isWithinDir(resolvedOut, resolvedRoot)) {
      throw new Error(`Security Error: Refusing to write outside workspace: ${ONTOLOGY_REL_PATH}`);
    }
    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
    fs.writeFileSync(resolvedOut, JSON.stringify(inferred, null, 2) + '\n', 'utf8');
  }
  return {
    written: shouldWrite,
    alreadyExists: exists,
    dryRun,
    path: ONTOLOGY_REL_PATH,
    valid: validation.valid,
    errors: validation.errors,
    ontology: inferred,
  };
}
