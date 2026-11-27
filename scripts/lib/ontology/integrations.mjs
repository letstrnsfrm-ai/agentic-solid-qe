/**
 * Operational QE Ontology — Modular integration helpers for Cortex CLI scripts.
 * Keeps legacy baselined monoliths within their #73 line-count ratchet caps.
 * Zero external runtime dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ONTOLOGY_REL_PATH, loadOntology } from './core.mjs';
import { validateOntology } from './validate.mjs';
import { compileOntologyIndex, querySemanticImpact } from './compile.mjs';

/** Progressive Strictness ontology audit hook for `audit-solid.mjs`. */
export function auditOntologyGate(rootDir, { violations, warnings }) {
  const loaded = loadOntology(rootDir);
  if (!loaded.exists) return '';
  if (loaded.parseError) {
    violations.push(`[Operational Ontology Gate] ${loaded.parseError}`);
    return '';
  }
  const res = validateOntology(loaded.ontology, { rootDir, checkSrcSymbols: true });
  for (const err of res.errors) violations.push(`[Operational Ontology Gate] ${err}`);
  if (!res.valid) return '';
  const compiled = compileOntologyIndex(rootDir, loaded.ontology);
  if (!compiled) return '';
  const os = compiled.summary;
  for (const inv of compiled.coverage.invariants.uncovered) {
    if (inv.severity === 'p0') {
      warnings.push(`[Ontology Coverage Gap] Uncovered P0 invariant '${inv.id}' on ${inv.entity}: ${inv.description}`);
    }
  }
  if (compiled.coverage.transitions.uncovered.length > 0) {
    const sample = compiled.coverage.transitions.uncovered.slice(0, 4).map((t) => t.key).join(', ');
    warnings.push(
      `[Ontology Coverage Gap] ${compiled.coverage.transitions.uncovered.length} uncovered state transition(s): ${sample}${compiled.coverage.transitions.uncovered.length > 4 ? ' ...' : ''}. Run 'npx cortex coverage --compact' to guide --explore.`
    );
  }
  return `, ontology: ${os.entities} entities (${os.coveredTransitions}/${os.transitions} transitions, ${os.coveredInvariants}/${os.invariants} invariants)`;
}

/** Coverage report section & compact formatter for `analyze-coverage.mjs`. */
export function buildOntologyCoverageSection(domainGraph) {
  if (!domainGraph?.ontology) return null;
  return {
    domain: domainGraph.ontology.domain,
    summary: domainGraph.ontology.summary,
    uncoveredEntities: domainGraph.ontology.coverage.entities.uncovered,
    uncoveredActions: domainGraph.ontology.coverage.actions.uncovered,
    uncoveredTransitions: domainGraph.ontology.coverage.transitions.uncovered,
    uncoveredInvariants: domainGraph.ontology.coverage.invariants.uncovered,
    topGaps: domainGraph.ontology.coverage.gaps.slice(0, 8),
  };
}

export function formatCompactOntologyCoverageLine(report) {
  const os = report?.ontologyCoverage?.summary;
  if (!os) return null;
  const topGapTargets = (report.ontologyCoverage.topGaps || []).slice(0, 3).map((g) => g.target);
  return `ONTOL  | entities=${os.coveredEntities}/${os.entities} transitions=${os.coveredTransitions}/${os.transitions} invariants=${os.coveredInvariants}/${os.invariants}${topGapTargets.length ? ` | gaps=[${topGapTargets.join(', ')}]` : ''}`;
}

/** Stage 2+ GATE_OPTIONS enrichment for `orchestrate.mjs`. */
export function appendOntologyGateOptions(coverage, stageOptions, whyParts) {
  const ontCov = coverage?.ontologyCoverage || null;
  const topGaps = Array.isArray(ontCov?.topGaps) ? ontCov.topGaps : [];
  if (topGaps.length > 0) {
    const topGap = topGaps[0];
    const safeTarget = String(topGap.target || 'gap').replace(/[^a-zA-Z0-9_>:-]/g, '');
    const safeEntity = String(topGap.entity || 'domain').replace(/[^a-zA-Z0-9_-]/g, '');
    const safeSlug = `${safeEntity}-${topGap.kind === 'invariant' ? safeTarget : 'transition'}`
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
    stageOptions.push({
      id: 'ontology-gap-explore',
      label: `(Recommended) Cover [${String(topGap.priority || 'p1').toUpperCase()}] ontology ${topGap.kind} '${safeTarget}' on ${safeEntity}`,
      command: `npx cortex orchestrate --explore start --scenario ${safeSlug}`,
    });
    whyParts.push(`Operational QE Ontology reports ${topGaps.length} uncovered semantic gap(s) (top: ${topGap.target}).`);
    return true;
  }
  if (!ontCov) {
    stageOptions.push({
      id: 'ontology-seed',
      label: 'Infer starter Operational QE Ontology (.agents/domain/ontology.json) for semantic coverage & impact',
      command: 'npx cortex ontology --seed',
    });
  }
  return false;
}

/** Entity/Action Context Pack helpers for `context-pack.mjs`. */
export function resolveContextOntologySlice(rootDir, { entity = '', action = '' } = {}) {
  if (!entity && !action) return null;
  const compiledOnt = compileOntologyIndex(rootDir);
  if (!compiledOnt) return null;
  const { byEntity, byAction, byInvariant } = compiledOnt.semanticIndex;
  const uncoveredTransSet = new Set((compiledOnt.coverage?.transitions?.uncovered || []).map((t) => t.key));
  let targetAction = null;
  if (action) {
    const actKey = Object.keys(byAction).find((k) => k.toLowerCase() === String(action).toLowerCase());
    if (actKey) targetAction = byAction[actKey];
  }
  const entityNeedle = entity || targetAction?.targetEntity || '';
  const entKey = entityNeedle
    ? Object.keys(byEntity).find((k) => k.toLowerCase() === String(entityNeedle).toLowerCase())
    : null;
  const targetEntity = entKey ? byEntity[entKey] : null;
  if (!targetEntity && !targetAction) return null;

  const invIds = [...new Set([...(targetEntity?.invariants || []), ...(targetAction?.invariants || [])])];
  const invariants = invIds
    .map((id) => byInvariant[id])
    .filter(Boolean)
    .map((inv) => ({ id: inv.id, severity: inv.severity, covered: inv.specs.length > 0 || inv.tapes.length > 0, description: inv.description }));

  const transitions = [];
  if (targetEntity) {
    try {
      const rawOnt = JSON.parse(fs.readFileSync(path.join(rootDir, ONTOLOGY_REL_PATH), 'utf8'));
      const rawEnt = (Array.isArray(rawOnt?.entities) ? rawOnt.entities : []).find((e) => e.id === targetEntity.id);
      for (const tr of Array.isArray(rawEnt?.transitions) ? rawEnt.transitions : []) {
        const key = `${targetEntity.id}:${tr.from}->${tr.to}`;
        transitions.push({ from: tr.from, to: tr.to, viaAction: tr.viaAction, covered: !uncoveredTransSet.has(key) });
      }
    } catch {
      /* ignore */
    }
  }
  return {
    domain: compiledOnt.domain,
    entity: targetEntity ? { ...targetEntity, transitions } : null,
    action: targetAction ? { ...targetAction } : null,
    invariants,
  };
}

export function collectOntologyKeywords(slice) {
  const kw = [];
  if (slice?.entity) {
    kw.push(slice.entity.id);
    for (const c of slice.entity.components || []) kw.push(c.replace(/Component|Page/g, ''));
    for (const b of slice.entity.dataBuilders || []) kw.push(b.replace(/Builder/g, ''));
    for (const r of slice.entity.routes || []) kw.push(...String(r).split(/[/?=&_-]+/).filter(Boolean));
  }
  if (slice?.action) {
    kw.push(slice.action.id);
    for (const c of slice.action.components || []) kw.push(c.replace(/Component|Page/g, ''));
  }
  return kw;
}

export function formatContextOntologyLines(slice) {
  if (!slice) return [];
  const lines = [];
  if (slice.entity) {
    const relStr = slice.entity.relatedEntities.length > 0 ? ` | rel=[${slice.entity.relatedEntities.join(', ')}]` : '';
    lines.push(`ENTITY | ${slice.entity.id} (${slice.entity.ownerSquad}) | states=[${slice.entity.states.join(', ')}]${relStr}`);
    if (slice.entity.transitions.length > 0) {
      lines.push(`TRANS  | ${slice.entity.transitions.slice(0, 6).map((t) => `${t.from}->${t.to}(${t.covered ? 'ok' : 'GAP'})`).join(', ')}`);
    }
  }
  if (slice.action) {
    const apiStr = slice.action.apiEndpoints.length > 0 ? ` | api=[${slice.action.apiEndpoints.join(', ')}]` : '';
    lines.push(`ACTION | ${slice.action.id} -> ${slice.action.targetEntity} | personas=[${slice.action.actorPersonas.join(', ')}]${apiStr}`);
  }
  if (slice.invariants.length > 0) {
    lines.push(`INVAR  | ${slice.invariants.slice(0, 5).map((i) => `[${i.severity.toUpperCase()} ${i.covered ? 'ok' : 'GAP'}] ${i.id}`).join(' | ')}`);
  }
  return lines;
}

/** Ontology-aware drift healing helpers for `heal-drift.mjs`. */
export function resolveHealOntologyContext(projectRoot, { componentMatch, specPath, tapeMatch }) {
  try {
    const compiledOnt = compileOntologyIndex(projectRoot);
    if (!compiledOnt) return null;
    const semFiles = componentMatch?.relPath ? [componentMatch.relPath] : [];
    const sem = querySemanticImpact(projectRoot, { files: semFiles, compiledOntology: compiledOnt });
    const entSet = new Set(sem.entities);
    const actSet = new Set(sem.actions);
    const invSet = new Set(sem.invariants);
    const normSpec = specPath ? String(specPath).replace(/\\/g, '/').replace(/^\.\//, '') : '';
    if (normSpec) {
      for (const [eid, rec] of Object.entries(compiledOnt.semanticIndex.byEntity)) if (rec.specs.includes(normSpec)) entSet.add(eid);
      for (const [aid, rec] of Object.entries(compiledOnt.semanticIndex.byAction)) if (rec.specs.includes(normSpec)) actSet.add(aid);
      for (const [iid, rec] of Object.entries(compiledOnt.semanticIndex.byInvariant)) if (rec.specs.includes(normSpec)) invSet.add(iid);
    }
    if (tapeMatch?.tape?.ontology) {
      for (const e of tapeMatch.tape.ontology.entities || []) entSet.add(e);
      for (const a of tapeMatch.tape.ontology.actions || []) actSet.add(a);
      for (const i of tapeMatch.tape.ontology.invariants || []) invSet.add(i);
    }
    const invariants = [...invSet]
      .map((id) => compiledOnt.semanticIndex.byInvariant[id])
      .filter(Boolean)
      .map((inv) => ({ id: inv.id, severity: inv.severity, description: inv.description }));
    if (entSet.size === 0 && actSet.size === 0 && invariants.length === 0) return null;
    return {
      domain: compiledOnt.domain,
      entities: [...entSet].sort(),
      actions: [...actSet].sort(),
      invariants,
      p0Invariants: invariants.filter((i) => i.severity === 'p0').map((i) => i.id),
    };
  } catch {
    return null;
  }
}

export function formatHealDefectOntologyLines(ctx) {
  if (!ctx) return [];
  return [
    '',
    '## Affected Operational Ontology',
    `- **Entities:** ${ctx.entities.map((e) => `\`${e}\``).join(', ') || '_none_'}`,
    `- **Actions:** ${ctx.actions.map((a) => `\`${a}\``).join(', ') || '_none_'}`,
    `- **Invariants:** ${ctx.invariants.length > 0 ? ctx.invariants.map((i) => `\`${i.id}\` (${i.severity.toUpperCase()})`).join(', ') : '_none_'}`,
  ];
}

export function formatHealCompactOntologyLine(ctx) {
  if (!ctx) return null;
  const invSummary = ctx.invariants.slice(0, 4).map((i) => `${i.id}(${i.severity.toUpperCase()})`).join(', ');
  return `ONTOL  | entities=[${ctx.entities.join(', ')}]${invSummary ? ` | invariants=[${invSummary}]` : ''}`;
}

/** Sanitized Cloud telemetry KPI rollup for `report-cloud.mjs`. */
export function buildCloudOntologyCoverage(covJson) {
  const ontCov = covJson?.ontologyCoverage;
  if (!ontCov?.summary) return {};
  return {
    ontologyCoverage: {
      domain: String(ontCov.domain || ''),
      entities: Number(ontCov.summary.entities ?? 0),
      coveredEntities: Number(ontCov.summary.coveredEntities ?? 0),
      transitions: Number(ontCov.summary.transitions ?? 0),
      coveredTransitions: Number(ontCov.summary.coveredTransitions ?? 0),
      invariants: Number(ontCov.summary.invariants ?? 0),
      coveredInvariants: Number(ontCov.summary.coveredInvariants ?? 0),
      uncoveredP0Invariants: Number(ontCov.summary.uncoveredP0Invariants ?? 0),
    },
  };
}

/** System Map model & HTML snippet builders for `build-system-map.mjs`. */
export function buildSystemMapOntologyModel(rootDir) {
  const compiled = compileOntologyIndex(rootDir);
  if (!compiled) return null;
  return {
    domain: compiled.domain,
    summary: compiled.summary,
    entities: Object.values(compiled.semanticIndex.byEntity).map((e) => ({
      id: e.id, name: e.name, ownerSquad: e.ownerSquad, states: e.states,
      relatedEntities: e.relatedEntities, routes: e.routes, components: e.components,
      actions: e.actions, invariants: e.invariants, covered: e.specs.length > 0 || e.tapes.length > 0,
    })),
    links: compiled.links || [],
    invariants: Object.values(compiled.semanticIndex.byInvariant).map((i) => ({
      id: i.id, severity: i.severity, entity: i.entity, action: i.action,
      description: i.description, covered: i.specs.length > 0 || i.tapes.length > 0, specs: i.specs,
    })),
    uncoveredTransitions: compiled.coverage.transitions.uncovered,
    gaps: compiled.coverage.gaps.slice(0, 12),
  };
}

export const SYSTEM_MAP_ONTOLOGY_SECTION_HTML =
  '<section id="view-ontology" class="view"><div class="kpis" id="ontology-kpis" style="margin-bottom:16px;"></div><div class="card"><h3 style="margin-top:0;font-size:14px;">Domain Entities, Lifecycles &amp; Typed Links</h3><table id="ontology-entities-table"></table></div><div class="card"><h3 style="margin-top:0;font-size:14px;">Business Invariants &amp; Semantic Coverage</h3><table id="ontology-invariants-table"></table></div></section>';

export const SYSTEM_MAP_ONTOLOGY_BIZ_KPI_JS =
  "...(MODEL.ontology?.summary ? [{ val: MODEL.ontology.summary.coveredInvariants + '/' + MODEL.ontology.summary.invariants, badge: MODEL.ontology.summary.uncoveredP0Invariants > 0 ? '<span class=\"pill red\">' + MODEL.ontology.summary.uncoveredP0Invariants + ' P0 Gap</span>' : '<span class=\"pill green\">P0 Protected</span>', lbl: 'Ontology Invariants Verified', sub: MODEL.ontology.summary.entities + ' entities · ' + MODEL.ontology.summary.coveredTransitions + '/' + MODEL.ontology.summary.transitions + ' state transitions' }] : []),";

export const SYSTEM_MAP_ONTOLOGY_RENDERER_JS = `function renderOntologyView(){const k=document.getElementById('ontology-kpis'),e=document.getElementById('ontology-entities-table'),v=document.getElementById('ontology-invariants-table');if(!MODEL.ontology){k.innerHTML='<div class="subtitle">No <code>.agents/domain/ontology.json</code> configured yet. Run <code>npx cortex ontology --seed</code>.</div>';e.innerHTML='';v.innerHTML='';return;}const o=MODEL.ontology.summary;k.innerHTML=[{val:o.coveredEntities+'/'+o.entities,lbl:'Domain Entities',sub:o.links+' typed links · '+o.actions+' actions'},{val:o.coveredTransitions+'/'+o.transitions,lbl:'State Transitions Covered',sub:(o.transitions-o.coveredTransitions)+' uncovered transition(s)'},{val:o.coveredInvariants+'/'+o.invariants,lbl:'Business Invariants Verified',sub:o.uncoveredP0Invariants+' uncovered P0 invariant(s)'}].map(x=>'<div class="kpi"><div class="val">'+esc(x.val)+'</div><div class="lbl">'+esc(x.lbl)+'</div><div class="sub">'+esc(x.sub)+'</div></div>').join('');e.innerHTML='<thead><tr><th>Entity</th><th>Owner</th><th>Lifecycle States</th><th>Related</th><th>Components</th><th>Status</th></tr></thead><tbody>'+MODEL.ontology.entities.map(x=>'<tr><td><strong>'+esc(x.id)+'</strong><br/><span class="subtitle">'+esc(x.name)+'</span></td><td><code>'+esc(x.ownerSquad)+'</code></td><td>'+x.states.map(s=>'<span class="pill neutral" style="margin-right:4px;">'+esc(s)+'</span>').join('')+'</td><td>'+(x.relatedEntities.length?x.relatedEntities.map(r=>'<code>'+esc(r)+'</code>').join(' '):'—')+'</td><td>'+(x.components.length?x.components.map(c=>'<code>'+esc(c)+'</code>').join(' '):'—')+'</td><td>'+(x.covered?'<span class="pill green">Covered</span>':'<span class="pill amber">Uncovered</span>')+'</td></tr>').join('')+'</tbody>';v.innerHTML='<thead><tr><th>Invariant</th><th>Severity</th><th>Entity</th><th>Rule</th><th>Status</th></tr></thead><tbody>'+MODEL.ontology.invariants.map(x=>'<tr><td><code>'+esc(x.id)+'</code></td><td><span class="pill '+(x.severity==='p0'?'purple':'neutral')+'">'+esc(x.severity.toUpperCase())+'</span></td><td><strong>'+esc(x.entity)+'</strong></td><td>'+esc(x.description)+'</td><td>'+(x.covered?'<span class="pill green">Verified</span>':'<span class="pill amber">Gap</span>')+'</td></tr>').join('')+'</tbody>';}renderOntologyView();`;
