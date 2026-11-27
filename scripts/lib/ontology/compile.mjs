/**
 * Operational QE Ontology — Compiler & Semantic Impact Query Engine.
 * Zero external runtime dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ONTOLOGY_REL_PATH, collectSrcClassNames, loadOntology, walkFiles } from './core.mjs';

function addUnique(arr, val) {
  if (val && !arr.includes(val)) arr.push(val);
}

/**
 * Compiles `.agents/domain/ontology.json` + Session Tapes + Playwright Specs + `src/`
 * into the `ontology` section of `domain-graph.json` v3.0.0.
 */
export function compileOntologyIndex(rootDir = process.cwd(), loadedOntology = null) {
  let ontology = loadedOntology;
  if (!ontology) {
    const loaded = loadOntology(rootDir);
    if (!loaded.exists || !loaded.ontology) return null;
    ontology = loaded.ontology;
  }
  if (!ontology || typeof ontology !== 'object' || Array.isArray(ontology)) return null;

  const entitiesArr = Array.isArray(ontology.entities) ? ontology.entities : [];
  const actionsArr = Array.isArray(ontology.actions) ? ontology.actions : [];
  const linksArr = Array.isArray(ontology.links) ? ontology.links : [];
  const invariantsArr = Array.isArray(ontology.invariants) ? ontology.invariants : [];

  const srcClasses = collectSrcClassNames(rootDir);

  // 1. Scan Specs & extract tape traceability + explicit @entity/@action/@inv tags
  const specFiles = walkFiles(path.join(rootDir, 'tests'), '.spec.ts');
  const specs = specFiles.map((f) => {
    const rel = path.relative(rootDir, f).replace(/\\/g, '/');
    let content = '';
    try {
      content = fs.readFileSync(f, 'utf8');
    } catch {
      /* ignore */
    }
    const entityTags = [...new Set([...content.matchAll(/@entity:([A-Za-z][A-Za-z0-9_-]*)/g)].map((m) => m[1]))];
    const actionTags = [...new Set([...content.matchAll(/@action:([A-Za-z][A-Za-z0-9_-]*)/g)].map((m) => m[1]))];
    const invTags = [...new Set([...content.matchAll(/@inv:([a-z0-9-]+)/g)].map((m) => m[1]))];
    return { file: rel, content, entityTags, actionTags, invTags };
  });

  // 2. Scan Session Tapes & map each tape to matching compiled specs
  const tapeFiles = walkFiles(path.join(rootDir, '.exploratory/tapes'), '.json');
  const tapes = [];
  for (const tf of tapeFiles) {
    let tape;
    try {
      tape = JSON.parse(fs.readFileSync(tf, 'utf8'));
    } catch {
      continue;
    }
    if (!tape || typeof tape !== 'object' || Array.isArray(tape)) continue;
    const scenarioId = String(tape.scenarioId || path.basename(tf, '.json'));
    const relTape = path.relative(rootDir, tf).replace(/\\/g, '/');
    const slugTokens = scenarioId.split('-').filter((w) => w.length > 3);
    const matchedSpecs = specs
      .filter(
        (sp) =>
          sp.content.includes(scenarioId) ||
          sp.file.includes(scenarioId) ||
          (slugTokens.length > 0 &&
            slugTokens.every((tok) => sp.file.toLowerCase().includes(tok.toLowerCase())))
      )
      .map((sp) => sp.file);
    tapes.push({
      scenarioId,
      file: relTape,
      persona: tape.persona?.role || '',
      ontology: tape.ontology || null,
      matchedSpecs,
      components: [
        ...new Set(
          (Array.isArray(tape.semanticSteps) ? tape.semanticSteps : [])
            .map((s) => s?.componentCandidate)
            .filter(Boolean)
        ),
      ],
    });
  }

  // 3. Build Coverage & Reverse Semantic Indexes
  const byEntity = Object.create(null);
  const byAction = Object.create(null);
  const byComponent = Object.create(null);
  const byApi = Object.create(null);
  const byRoute = Object.create(null);
  const byInvariant = Object.create(null);

  const ensureCompBucket = (comp) => {
    if (!Object.hasOwn(byComponent, comp)) {
      byComponent[comp] = { file: srcClasses[comp] || null, entities: [], actions: [], invariants: [], tapes: [], specs: [] };
    }
    return byComponent[comp];
  };
  const ensureRouteBucket = (route) => {
    if (!Object.hasOwn(byRoute, route)) byRoute[route] = { entities: [], actions: [], invariants: [] };
    return byRoute[route];
  };
  const ensureApiBucket = (apiKey) => {
    if (!Object.hasOwn(byApi, apiKey)) byApi[apiKey] = { actions: [], entities: [], invariants: [], tapes: [], specs: [] };
    return byApi[apiKey];
  };

  const transitionEntries = [];
  const transitionMap = new Map();
  for (const ent of entitiesArr) {
    if (!ent || typeof ent !== 'object' || !ent.id) continue;
    byEntity[ent.id] = {
      id: ent.id,
      name: ent.name,
      ownerSquad: ent.ownerSquad || '@org/unassigned',
      states: Array.isArray(ent.states) ? ent.states : [],
      routes: Array.isArray(ent.routes) ? [...ent.routes] : [],
      components: Array.isArray(ent.components) ? [...ent.components] : [],
      dataBuilders: Array.isArray(ent.dataBuilders) ? [...ent.dataBuilders] : [],
      actions: [],
      invariants: [],
      relatedEntities: [],
      tapes: [],
      specs: [],
    };
    for (const r of byEntity[ent.id].routes) addUnique(ensureRouteBucket(r).entities, ent.id);
    for (const c of byEntity[ent.id].components) addUnique(ensureCompBucket(c).entities, ent.id);
    for (const tr of Array.isArray(ent.transitions) ? ent.transitions : []) {
      if (!tr || typeof tr !== 'object') continue;
      const key = `${ent.id}:${tr.from}->${tr.to}`;
      const record = {
        key,
        entity: ent.id,
        from: tr.from,
        to: tr.to,
        viaAction: tr.viaAction,
        ...(tr.guard ? { guard: tr.guard } : {}),
        tapes: [],
        specs: [],
      };
      transitionEntries.push(record);
      transitionMap.set(key, record);
    }
  }

  for (const lnk of linksArr) {
    if (!lnk || typeof lnk !== 'object') continue;
    if (byEntity[lnk.from]) addUnique(byEntity[lnk.from].relatedEntities, lnk.to);
    if (byEntity[lnk.to]) addUnique(byEntity[lnk.to].relatedEntities, lnk.from);
  }

  for (const act of actionsArr) {
    if (!act || typeof act !== 'object' || !act.id) continue;
    const apiKeys = (Array.isArray(act.apiEndpoints) ? act.apiEndpoints : []).map((ep) => `${ep.method} ${ep.pathPattern}`);
    byAction[act.id] = {
      id: act.id,
      name: act.name,
      targetEntity: act.targetEntity,
      mutatesEntities: Array.isArray(act.mutatesEntities) ? [...act.mutatesEntities] : [],
      actorPersonas: Array.isArray(act.actorPersonas) ? [...act.actorPersonas] : [],
      routes: Array.isArray(act.routes) ? [...act.routes] : [],
      apiEndpoints: apiKeys,
      components: Array.isArray(act.components) ? [...act.components] : [],
      invariants: [],
      tapes: [],
      specs: [],
    };
    if (byEntity[act.targetEntity]) addUnique(byEntity[act.targetEntity].actions, act.id);
    for (const me of byAction[act.id].mutatesEntities) {
      if (byEntity[me]) addUnique(byEntity[me].actions, act.id);
    }
    for (const r of byAction[act.id].routes) addUnique(ensureRouteBucket(r).actions, act.id);
    for (const c of byAction[act.id].components) addUnique(ensureCompBucket(c).actions, act.id);
    for (const ak of apiKeys) {
      const bucket = ensureApiBucket(ak);
      addUnique(bucket.actions, act.id);
      addUnique(bucket.entities, act.targetEntity);
      for (const me of byAction[act.id].mutatesEntities) addUnique(bucket.entities, me);
    }
  }

  for (const inv of invariantsArr) {
    if (!inv || typeof inv !== 'object' || !inv.id) continue;
    byInvariant[inv.id] = {
      id: inv.id,
      description: inv.description,
      severity: inv.severity,
      entity: inv.entity,
      action: inv.action || null,
      personas: Array.isArray(inv.personas) ? [...inv.personas] : [],
      routes: Array.isArray(inv.enforcedBy?.routes) ? [...inv.enforcedBy.routes] : [],
      components: Array.isArray(inv.enforcedBy?.components) ? [...inv.enforcedBy.components] : [],
      apiEndpoints: Array.isArray(inv.enforcedBy?.apiEndpoints) ? [...inv.enforcedBy.apiEndpoints] : [],
      tapes: [],
      specs: [],
    };
    if (byEntity[inv.entity]) addUnique(byEntity[inv.entity].invariants, inv.id);
    if (inv.action && byAction[inv.action]) addUnique(byAction[inv.action].invariants, inv.id);
    for (const r of byInvariant[inv.id].routes) addUnique(ensureRouteBucket(r).invariants, inv.id);
    for (const c of byInvariant[inv.id].components) addUnique(ensureCompBucket(c).invariants, inv.id);
    for (const ak of byInvariant[inv.id].apiEndpoints) addUnique(ensureApiBucket(ak).invariants, inv.id);
  }

  // 4. Bind Tapes -> Entities, Actions, Transitions, Invariants, Components, APIs
  for (const tape of tapes) {
    const ont = tape.ontology;
    if (ont && typeof ont === 'object') {
      for (const entId of Array.isArray(ont.entities) ? ont.entities : []) {
        if (byEntity[entId]) {
          addUnique(byEntity[entId].tapes, tape.scenarioId);
          for (const sp of tape.matchedSpecs) addUnique(byEntity[entId].specs, sp);
        }
      }
      for (const actId of Array.isArray(ont.actions) ? ont.actions : []) {
        if (byAction[actId]) {
          addUnique(byAction[actId].tapes, tape.scenarioId);
          for (const sp of tape.matchedSpecs) addUnique(byAction[actId].specs, sp);
          for (const ak of byAction[actId].apiEndpoints) {
            addUnique(ensureApiBucket(ak).tapes, tape.scenarioId);
            for (const sp of tape.matchedSpecs) addUnique(ensureApiBucket(ak).specs, sp);
          }
        }
      }
      for (const trKey of Array.isArray(ont.transitions) ? ont.transitions : []) {
        const rec = transitionMap.get(trKey);
        if (rec) {
          addUnique(rec.tapes, tape.scenarioId);
          for (const sp of tape.matchedSpecs) addUnique(rec.specs, sp);
        }
      }
      for (const invId of Array.isArray(ont.invariants) ? ont.invariants : []) {
        if (byInvariant[invId]) {
          addUnique(byInvariant[invId].tapes, tape.scenarioId);
          for (const sp of tape.matchedSpecs) addUnique(byInvariant[invId].specs, sp);
        }
      }
    }
    for (const comp of tape.components) {
      if (Object.hasOwn(byComponent, comp)) {
        addUnique(byComponent[comp].tapes, tape.scenarioId);
        for (const sp of tape.matchedSpecs) addUnique(byComponent[comp].specs, sp);
      }
    }
  }

  for (const sp of specs) {
    for (const entId of sp.entityTags) if (byEntity[entId]) addUnique(byEntity[entId].specs, sp.file);
    for (const actId of sp.actionTags) if (byAction[actId]) addUnique(byAction[actId].specs, sp.file);
    for (const invId of sp.invTags) if (byInvariant[invId]) addUnique(byInvariant[invId].specs, sp.file);
  }

  // 5. Coverage & Prioritized Gaps
  const entityRecords = Object.values(byEntity);
  const actionRecords = Object.values(byAction);
  const invariantRecords = Object.values(byInvariant);
  const isCovered = (rec) => rec.specs.length > 0 || rec.tapes.length > 0;

  const uncoveredEntities = entityRecords.filter((e) => !isCovered(e)).map((e) => e.id);
  const uncoveredActions = actionRecords.filter((a) => !isCovered(a)).map((a) => a.id);
  const uncoveredTransitions = transitionEntries
    .filter((t) => !isCovered(t))
    .map((t) => ({ key: t.key, entity: t.entity, from: t.from, to: t.to, viaAction: t.viaAction }));
  const severityRank = { p0: 0, p1: 1, p2: 2 };
  const uncoveredInvariants = invariantRecords
    .filter((i) => !isCovered(i))
    .sort((a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9))
    .map((i) => ({ id: i.id, severity: i.severity, entity: i.entity, action: i.action, description: i.description }));

  const gaps = [
    ...uncoveredInvariants.map((i) => ({
      kind: 'invariant',
      priority: i.severity,
      target: i.id,
      entity: i.entity,
      summary: `[${i.severity.toUpperCase()}] Uncovered invariant '${i.id}' on ${i.entity}: ${i.description}`,
    })),
    ...uncoveredTransitions.map((t) => ({
      kind: 'transition',
      priority: 'p1',
      target: t.key,
      entity: t.entity,
      summary: `Uncovered state transition '${t.key}' via action '${t.viaAction}'`,
    })),
    ...uncoveredActions
      .filter((actId) => !uncoveredTransitions.some((t) => t.viaAction === actId))
      .map((actId) => ({
        kind: 'action',
        priority: 'p2',
        target: actId,
        entity: byAction[actId]?.targetEntity || null,
        summary: `Uncovered domain action '${actId}'`,
      })),
  ];

  const summary = {
    domain: ontology.domain,
    schemaVersion: ontology.schemaVersion,
    entities: entityRecords.length,
    links: linksArr.length,
    actions: actionRecords.length,
    transitions: transitionEntries.length,
    invariants: invariantRecords.length,
    coveredEntities: entityRecords.length - uncoveredEntities.length,
    coveredActions: actionRecords.length - uncoveredActions.length,
    coveredTransitions: transitionEntries.length - uncoveredTransitions.length,
    coveredInvariants: invariantRecords.length - uncoveredInvariants.length,
    uncoveredP0Invariants: uncoveredInvariants.filter((i) => i.severity === 'p0').length,
  };

  return {
    sourcePath: ONTOLOGY_REL_PATH,
    domain: ontology.domain,
    lastVerified: ontology.lastVerified || null,
    summary,
    links: linksArr,
    coverage: {
      entities: { total: entityRecords.length, covered: summary.coveredEntities, uncovered: uncoveredEntities },
      actions: { total: actionRecords.length, covered: summary.coveredActions, uncovered: uncoveredActions },
      transitions: { total: transitionEntries.length, covered: summary.coveredTransitions, uncovered: uncoveredTransitions },
      invariants: { total: invariantRecords.length, covered: summary.coveredInvariants, uncovered: uncoveredInvariants },
      gaps,
    },
    semanticIndex: { byEntity, byAction, byComponent, byApi, byRoute, byInvariant },
  };
}

/**
 * Traces semantic impact across the Operational QE Ontology given `entity`, `action`, `api`, or `files`.
 */
export function querySemanticImpact(
  rootDir = process.cwd(),
  { entity = null, action = null, api = null, files = [], compiledOntology = null } = {}
) {
  const compiled = compiledOntology || compileOntologyIndex(rootDir);
  if (!compiled) {
    return { hasOntology: false, query: { entity, action, api, files }, entities: [], relatedEntities: [], actions: [], invariants: [], components: [], routes: [], tapes: [], specs: [] };
  }
  const { byEntity, byAction, byComponent, byApi, byInvariant } = compiled.semanticIndex;
  const entitySet = new Set();
  const relatedEntitySet = new Set();
  const actionSet = new Set();
  const invariantSet = new Set();
  const componentSet = new Set();
  const routeSet = new Set();
  const tapeSet = new Set();
  const specSet = new Set();

  const includeEntity = (entId, includeRelated = true) => {
    const rec = byEntity[entId];
    if (!rec) return;
    entitySet.add(entId);
    for (const r of rec.routes) routeSet.add(r);
    for (const c of rec.components) componentSet.add(c);
    for (const a of rec.actions) actionSet.add(a);
    for (const i of rec.invariants) invariantSet.add(i);
    for (const t of rec.tapes) tapeSet.add(t);
    for (const sp of rec.specs) specSet.add(sp);
    if (includeRelated) for (const relEnt of rec.relatedEntities) relatedEntitySet.add(relEnt);
  };
  const includeAction = (actId) => {
    const rec = byAction[actId];
    if (!rec) return;
    actionSet.add(actId);
    if (rec.targetEntity) includeEntity(rec.targetEntity, true);
    for (const me of rec.mutatesEntities) includeEntity(me, false);
    for (const r of rec.routes) routeSet.add(r);
    for (const c of rec.components) componentSet.add(c);
    for (const i of rec.invariants) invariantSet.add(i);
    for (const t of rec.tapes) tapeSet.add(t);
    for (const sp of rec.specs) specSet.add(sp);
  };

  if (entity) {
    const k = Object.keys(byEntity).find((x) => x.toLowerCase() === String(entity).toLowerCase());
    if (k) includeEntity(k, true);
  }
  if (action) {
    const k = Object.keys(byAction).find((x) => x.toLowerCase() === String(action).toLowerCase());
    if (k) includeAction(k);
  }
  if (api) {
    const needle = String(api).trim().toLowerCase();
    for (const [apiKey, bucket] of Object.entries(byApi)) {
      if (apiKey.toLowerCase() === needle || apiKey.toLowerCase().includes(needle)) {
        for (const a of bucket.actions) includeAction(a);
        for (const e of bucket.entities) includeEntity(e, true);
        for (const i of bucket.invariants) invariantSet.add(i);
        for (const t of bucket.tapes) tapeSet.add(t);
        for (const sp of bucket.specs) specSet.add(sp);
      }
    }
  }

  const normalizedFiles = (files || []).map((f) => String(f || '').replace(/\\/g, '/').replace(/^\.\//, ''));
  if (normalizedFiles.length > 0) {
    const fileToClasses = new Map();
    for (const [compName, compInfo] of Object.entries(byComponent)) {
      if (compInfo.file) {
        if (!fileToClasses.has(compInfo.file)) fileToClasses.set(compInfo.file, []);
        fileToClasses.get(compInfo.file).push(compName);
      }
    }
    const srcClasses = collectSrcClassNames(rootDir);
    for (const f of normalizedFiles) {
      for (const comp of fileToClasses.get(f) || []) {
        const info = byComponent[comp];
        componentSet.add(comp);
        for (const e of info.entities) entitySet.add(e);
        for (const a of info.actions) actionSet.add(a);
        for (const i of info.invariants) invariantSet.add(i);
        for (const t of info.tapes) tapeSet.add(t);
        for (const sp of info.specs) specSet.add(sp);
      }
      for (const [clsName, clsFile] of Object.entries(srcClasses)) {
        if (clsFile === f) {
          for (const ent of Object.values(byEntity)) {
            if (ent.dataBuilders.includes(clsName)) includeEntity(ent.id, false);
          }
        }
      }
    }
  }

  for (const invId of invariantSet) {
    const inv = byInvariant[invId];
    if (!inv) continue;
    for (const t of inv.tapes) tapeSet.add(t);
    for (const sp of inv.specs) specSet.add(sp);
    for (const c of inv.components) componentSet.add(c);
    for (const r of inv.routes) routeSet.add(r);
  }
  for (const e of entitySet) relatedEntitySet.delete(e);

  return {
    hasOntology: true,
    domain: compiled.domain,
    query: { entity, action, api, files: normalizedFiles },
    entities: [...entitySet].sort(),
    relatedEntities: [...relatedEntitySet].sort(),
    actions: [...actionSet].sort(),
    invariants: [...invariantSet].sort(),
    components: [...componentSet].sort(),
    routes: [...routeSet].sort(),
    tapes: [...tapeSet].sort(),
    specs: [...specSet].sort(),
  };
}
