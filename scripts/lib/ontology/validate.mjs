/**
 * Operational QE Ontology — Schema, Referential Integrity & Tape Binding Validator.
 * Zero external runtime dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  CLASS_REGEX,
  DATE_REGEX,
  ID_REGEX,
  KEBAB_REGEX,
  ONTOLOGY_REL_PATH,
  SQUAD_REGEX,
  STATE_REGEX,
  TRANSITION_REF_REGEX,
  VALID_CARDINALITIES,
  VALID_HTTP_METHODS,
  VALID_RELATIONS,
  VALID_SEVERITIES,
  checkKeys,
  collectSrcClassNames,
} from './core.mjs';

const VALID_ROOT_KEYS = new Set([
  'schemaVersion',
  'domain',
  'description',
  'lastVerified',
  'entities',
  'links',
  'actions',
  'invariants',
]);
const VALID_ENTITY_KEYS = new Set([
  'id',
  'name',
  'description',
  'ownerSquad',
  'states',
  'transitions',
  'properties',
  'routes',
  'components',
  'dataBuilders',
]);
const VALID_TRANSITION_KEYS = new Set(['from', 'to', 'viaAction', 'guard']);
const VALID_PROPERTY_KEYS = new Set(['name', 'type', 'required', 'pii']);
const VALID_LINK_KEYS = new Set(['id', 'from', 'relation', 'to', 'cardinality', 'description']);
const VALID_ACTION_KEYS = new Set([
  'id',
  'name',
  'description',
  'actorPersonas',
  'targetEntity',
  'mutatesEntities',
  'fromState',
  'toState',
  'routes',
  'apiEndpoints',
  'components',
]);
const VALID_API_ENDPOINT_KEYS = new Set(['method', 'pathPattern']);
const VALID_INVARIANT_KEYS = new Set([
  'id',
  'description',
  'severity',
  'entity',
  'action',
  'personas',
  'enforcedBy',
]);
const VALID_ENFORCED_BY_KEYS = new Set(['routes', 'components', 'apiEndpoints']);
const VALID_TAPE_ONTOLOGY_KEYS = new Set(['entities', 'actions', 'transitions', 'invariants']);

/**
 * Validates an Operational QE Ontology object for schema conformance and referential integrity.
 * Returns `{ valid, errors, warnings }`.
 */
export function validateOntology(ontology, { rootDir = null, checkSrcSymbols = true } = {}) {
  const errors = [];
  const warnings = [];
  const label = `[${ONTOLOGY_REL_PATH}]`;

  if (!ontology || typeof ontology !== 'object' || Array.isArray(ontology)) {
    return { valid: false, errors: [`${label} Root must be a JSON object.`], warnings };
  }

  checkKeys(ontology, VALID_ROOT_KEYS, label, errors);

  for (const req of ['schemaVersion', 'domain', 'entities', 'links', 'actions', 'invariants']) {
    if (ontology[req] === undefined) {
      errors.push(`${label} Missing required root field '${req}'.`);
    }
  }

  if (ontology.schemaVersion !== '1.0.0') {
    errors.push(`${label} Unsupported schemaVersion '${ontology.schemaVersion}' (expected '1.0.0').`);
  }
  if (typeof ontology.domain !== 'string' || !KEBAB_REGEX.test(ontology.domain)) {
    errors.push(`${label} Invalid domain '${ontology.domain}'. Must match ^[a-z0-9-]+$.`);
  }
  if (ontology.lastVerified !== undefined && (typeof ontology.lastVerified !== 'string' || !DATE_REGEX.test(ontology.lastVerified))) {
    errors.push(`${label} Invalid lastVerified '${ontology.lastVerified}'. Expected YYYY-MM-DD.`);
  }

  const entities = Array.isArray(ontology.entities) ? ontology.entities : null;
  const actions = Array.isArray(ontology.actions) ? ontology.actions : null;
  const links = Array.isArray(ontology.links) ? ontology.links : null;
  const invariants = Array.isArray(ontology.invariants) ? ontology.invariants : null;

  // 1. Entities
  const entityMap = new Map();
  if (!entities || entities.length === 0) {
    errors.push(`${label} 'entities' must be a non-empty array.`);
  } else {
    entities.forEach((ent, idx) => {
      const eLabel = `${label} entities[${idx}]`;
      if (!ent || typeof ent !== 'object' || Array.isArray(ent)) {
        errors.push(`${eLabel} must be an object.`);
        return;
      }
      checkKeys(ent, VALID_ENTITY_KEYS, eLabel, errors);
      if (typeof ent.id !== 'string' || !ID_REGEX.test(ent.id)) {
        errors.push(`${eLabel}.id '${ent.id}' must match ^[A-Za-z][A-Za-z0-9_-]*$.`);
      } else if (entityMap.has(ent.id)) {
        errors.push(`${eLabel}.id '${ent.id}' is duplicated.`);
      }
      if (typeof ent.name !== 'string' || !ent.name.trim()) {
        errors.push(`${eLabel}.name must be a non-empty string.`);
      }
      if (ent.ownerSquad !== undefined && (typeof ent.ownerSquad !== 'string' || !SQUAD_REGEX.test(ent.ownerSquad))) {
        errors.push(`${eLabel}.ownerSquad '${ent.ownerSquad}' must match ^@[a-z0-9-]+/[a-z0-9-]+$.`);
      }
      const stateSet = new Set();
      if (!Array.isArray(ent.states) || ent.states.length === 0) {
        errors.push(`${eLabel}.states must be a non-empty array.`);
      } else {
        for (const st of ent.states) {
          if (typeof st !== 'string' || !STATE_REGEX.test(st)) {
            errors.push(`${eLabel}.states contains invalid state '${st}'.`);
          } else {
            stateSet.add(st);
          }
        }
      }
      if (ent.properties !== undefined) {
        if (!Array.isArray(ent.properties)) {
          errors.push(`${eLabel}.properties must be an array.`);
        } else {
          ent.properties.forEach((prop, pIdx) => {
            const pLabel = `${eLabel}.properties[${pIdx}]`;
            if (!prop || typeof prop !== 'object' || Array.isArray(prop)) {
              errors.push(`${pLabel} must be an object.`);
              return;
            }
            checkKeys(prop, VALID_PROPERTY_KEYS, pLabel, errors);
            if (typeof prop.name !== 'string' || !CLASS_REGEX.test(prop.name)) {
              errors.push(`${pLabel}.name '${prop.name}' is invalid.`);
            }
            if (typeof prop.type !== 'string' || !prop.type.trim()) {
              errors.push(`${pLabel}.type must be a non-empty string.`);
            }
          });
        }
      }
      for (const arrField of ['routes', 'components', 'dataBuilders']) {
        if (ent[arrField] !== undefined && !Array.isArray(ent[arrField])) {
          errors.push(`${eLabel}.${arrField} must be an array.`);
        }
      }
      if (typeof ent.id === 'string' && ID_REGEX.test(ent.id)) {
        entityMap.set(ent.id, { states: stateSet, entity: ent });
      }
    });
  }

  // 2. Actions
  const actionMap = new Map();
  if (!actions) {
    errors.push(`${label} 'actions' must be an array.`);
  } else {
    actions.forEach((act, idx) => {
      const aLabel = `${label} actions[${idx}]`;
      if (!act || typeof act !== 'object' || Array.isArray(act)) {
        errors.push(`${aLabel} must be an object.`);
        return;
      }
      checkKeys(act, VALID_ACTION_KEYS, aLabel, errors);
      if (typeof act.id !== 'string' || !ID_REGEX.test(act.id)) {
        errors.push(`${aLabel}.id '${act.id}' must match ^[A-Za-z][A-Za-z0-9_-]*$.`);
      } else if (actionMap.has(act.id)) {
        errors.push(`${aLabel}.id '${act.id}' is duplicated.`);
      }
      if (typeof act.name !== 'string' || !act.name.trim()) {
        errors.push(`${aLabel}.name must be a non-empty string.`);
      }
      if (typeof act.targetEntity !== 'string' || !entityMap.has(act.targetEntity)) {
        errors.push(`${aLabel}.targetEntity '${act.targetEntity}' does not reference a defined entity.`);
      } else {
        const targetStates = entityMap.get(act.targetEntity).states;
        if (act.fromState !== undefined && !targetStates.has(act.fromState)) {
          errors.push(`${aLabel}.fromState '${act.fromState}' is not a valid state of entity '${act.targetEntity}'.`);
        }
        if (act.toState !== undefined && !targetStates.has(act.toState)) {
          errors.push(`${aLabel}.toState '${act.toState}' is not a valid state of entity '${act.targetEntity}'.`);
        }
      }
      if (Array.isArray(act.mutatesEntities)) {
        for (const me of act.mutatesEntities) {
          if (!entityMap.has(me)) errors.push(`${aLabel}.mutatesEntities references unknown entity '${me}'.`);
        }
      }
      if (Array.isArray(act.apiEndpoints)) {
        act.apiEndpoints.forEach((ep, epIdx) => {
          const epLabel = `${aLabel}.apiEndpoints[${epIdx}]`;
          if (!ep || typeof ep !== 'object' || Array.isArray(ep)) {
            errors.push(`${epLabel} must be an object.`);
            return;
          }
          checkKeys(ep, VALID_API_ENDPOINT_KEYS, epLabel, errors);
          if (!VALID_HTTP_METHODS.has(ep.method)) {
            errors.push(`${epLabel}.method '${ep.method}' must be one of ${[...VALID_HTTP_METHODS].join(', ')}.`);
          }
          if (typeof ep.pathPattern !== 'string' || !ep.pathPattern.trim()) {
            errors.push(`${epLabel}.pathPattern must be a non-empty string.`);
          }
        });
      }
      if (typeof act.id === 'string' && ID_REGEX.test(act.id)) actionMap.set(act.id, act);
    });
  }

  // 2b. Entity transitions
  if (entities) {
    entities.forEach((ent, idx) => {
      if (!ent || !Array.isArray(ent.transitions)) return;
      const entry = entityMap.get(ent.id);
      if (!entry) return;
      ent.transitions.forEach((tr, tIdx) => {
        const tLabel = `${label} entities[${idx}].transitions[${tIdx}]`;
        if (!tr || typeof tr !== 'object' || Array.isArray(tr)) {
          errors.push(`${tLabel} must be an object.`);
          return;
        }
        checkKeys(tr, VALID_TRANSITION_KEYS, tLabel, errors);
        if (!entry.states.has(tr.from)) {
          errors.push(`${tLabel}.from '${tr.from}' is not a defined state on entity '${ent.id}'.`);
        }
        if (!entry.states.has(tr.to)) {
          errors.push(`${tLabel}.to '${tr.to}' is not a defined state on entity '${ent.id}'.`);
        }
        if (!actionMap.has(tr.viaAction)) {
          errors.push(`${tLabel}.viaAction '${tr.viaAction}' does not reference a defined action.`);
        }
      });
    });
  }

  // 3. Links
  const linkIds = new Set();
  if (!links) {
    errors.push(`${label} 'links' must be an array.`);
  } else {
    links.forEach((lnk, idx) => {
      const lLabel = `${label} links[${idx}]`;
      if (!lnk || typeof lnk !== 'object' || Array.isArray(lnk)) {
        errors.push(`${lLabel} must be an object.`);
        return;
      }
      checkKeys(lnk, VALID_LINK_KEYS, lLabel, errors);
      if (typeof lnk.id !== 'string' || !KEBAB_REGEX.test(lnk.id)) {
        errors.push(`${lLabel}.id '${lnk.id}' must match ^[a-z0-9-]+$.`);
      } else if (linkIds.has(lnk.id)) {
        errors.push(`${lLabel}.id '${lnk.id}' is duplicated.`);
      } else {
        linkIds.add(lnk.id);
      }
      if (!entityMap.has(lnk.from)) errors.push(`${lLabel}.from '${lnk.from}' does not reference a defined entity.`);
      if (!entityMap.has(lnk.to)) errors.push(`${lLabel}.to '${lnk.to}' does not reference a defined entity.`);
      if (!VALID_RELATIONS.has(lnk.relation)) errors.push(`${lLabel}.relation '${lnk.relation}' is invalid.`);
      if (lnk.cardinality !== undefined && !VALID_CARDINALITIES.has(lnk.cardinality)) {
        errors.push(`${lLabel}.cardinality '${lnk.cardinality}' is invalid.`);
      }
    });
  }

  // 4. Invariants
  const invIds = new Set();
  if (!invariants) {
    errors.push(`${label} 'invariants' must be an array.`);
  } else {
    invariants.forEach((inv, idx) => {
      const iLabel = `${label} invariants[${idx}]`;
      if (!inv || typeof inv !== 'object' || Array.isArray(inv)) {
        errors.push(`${iLabel} must be an object.`);
        return;
      }
      checkKeys(inv, VALID_INVARIANT_KEYS, iLabel, errors);
      if (typeof inv.id !== 'string' || !KEBAB_REGEX.test(inv.id)) {
        errors.push(`${iLabel}.id '${inv.id}' must match ^[a-z0-9-]+$.`);
      } else if (invIds.has(inv.id)) {
        errors.push(`${iLabel}.id '${inv.id}' is duplicated.`);
      } else {
        invIds.add(inv.id);
      }
      if (typeof inv.description !== 'string' || inv.description.trim().length < 5) {
        errors.push(`${iLabel}.description must be at least 5 characters.`);
      }
      if (!VALID_SEVERITIES.has(inv.severity)) errors.push(`${iLabel}.severity '${inv.severity}' must be p0, p1, or p2.`);
      if (!entityMap.has(inv.entity)) errors.push(`${iLabel}.entity '${inv.entity}' does not reference a defined entity.`);
      if (inv.action !== undefined && !actionMap.has(inv.action)) {
        errors.push(`${iLabel}.action '${inv.action}' does not reference a defined action.`);
      }
      if (inv.enforcedBy !== undefined) {
        if (!inv.enforcedBy || typeof inv.enforcedBy !== 'object' || Array.isArray(inv.enforcedBy)) {
          errors.push(`${iLabel}.enforcedBy must be an object.`);
        } else {
          checkKeys(inv.enforcedBy, VALID_ENFORCED_BY_KEYS, `${iLabel}.enforcedBy`, errors);
        }
      }
    });
  }

  // 5. Optional src/ symbol integrity check (guarded against non-array malformed inputs)
  if (rootDir && checkSrcSymbols && fs.existsSync(path.join(rootDir, 'src'))) {
    const srcClasses = collectSrcClassNames(rootDir);
    if (Object.keys(srcClasses).length > 0) {
      for (const ent of entities || []) {
        if (!ent || typeof ent !== 'object') continue;
        for (const comp of Array.isArray(ent.components) ? ent.components : []) {
          if (!Object.hasOwn(srcClasses, comp)) {
            errors.push(`${label} Entity '${ent.id}' references missing src/ class '${comp}'.`);
          }
        }
        for (const builder of Array.isArray(ent.dataBuilders) ? ent.dataBuilders : []) {
          if (!Object.hasOwn(srcClasses, builder)) {
            errors.push(`${label} Entity '${ent.id}' references missing Data Builder '${builder}'.`);
          }
        }
      }
      for (const act of actions || []) {
        if (!act || typeof act !== 'object') continue;
        for (const comp of Array.isArray(act.components) ? act.components : []) {
          if (!Object.hasOwn(srcClasses, comp)) {
            errors.push(`${label} Action '${act.id}' references missing src/ class '${comp}'.`);
          }
        }
      }
      for (const inv of invariants || []) {
        if (!inv || typeof inv !== 'object') continue;
        for (const comp of Array.isArray(inv.enforcedBy?.components) ? inv.enforcedBy.components : []) {
          if (!Object.hasOwn(srcClasses, comp)) {
            errors.push(`${label} Invariant '${inv.id}' references missing src/ class '${comp}'.`);
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Validates optional `tape.ontology` bindings against schema rules and (when present) `.agents/domain/ontology.json`.
 */
export function validateTapeOntologyBindings(tape, file, ontology = null) {
  const errors = [];
  if (tape?.ontology === undefined) return errors;
  if (!tape.ontology || typeof tape.ontology !== 'object' || Array.isArray(tape.ontology)) {
    errors.push(`[${file}] 'ontology' must be a JSON object.`);
    return errors;
  }
  checkKeys(tape.ontology, VALID_TAPE_ONTOLOGY_KEYS, `[${file}] ontology`, errors);
  const entList = Array.isArray(ontology?.entities) ? ontology.entities : null;
  const actList = Array.isArray(ontology?.actions) ? ontology.actions : null;
  const invList = Array.isArray(ontology?.invariants) ? ontology.invariants : null;
  const entIds = entList ? new Set(entList.map((e) => e?.id).filter(Boolean)) : null;
  const actIds = actList ? new Set(actList.map((a) => a?.id).filter(Boolean)) : null;
  const invIds = invList ? new Set(invList.map((i) => i?.id).filter(Boolean)) : null;
  const transitionKeys = entList
    ? new Set(entList.flatMap((e) => (Array.isArray(e?.transitions) ? e.transitions : []).map((tr) => `${e.id}:${tr.from}->${tr.to}`)))
    : null;

  const checkArr = (field, regex, validSet, fmtHint) => {
    if (tape.ontology[field] === undefined) return;
    if (!Array.isArray(tape.ontology[field])) {
      errors.push(`[${file}] ontology.${field} must be an array.`);
      return;
    }
    for (const item of tape.ontology[field]) {
      if (typeof item !== 'string' || !regex.test(item)) {
        errors.push(`[${file}] Invalid ontology.${field} entry '${item}'.${fmtHint ? ` ${fmtHint}` : ''}`);
      } else if (validSet && !validSet.has(item)) {
        errors.push(`[${file}] ontology.${field} references unknown entry '${item}' (not in ${ONTOLOGY_REL_PATH}).`);
      }
    }
  };
  checkArr('entities', ID_REGEX, entIds, '');
  checkArr('actions', ID_REGEX, actIds, '');
  checkArr('transitions', TRANSITION_REF_REGEX, transitionKeys, "Expected 'Entity:from->to'.");
  checkArr('invariants', KEBAB_REGEX, invIds, '');
  return errors;
}
