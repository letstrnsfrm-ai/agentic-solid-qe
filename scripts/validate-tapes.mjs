#!/usr/bin/env node
/**
 * Validates all JSON Session Tapes in .exploratory/tapes/ against .agents/domain/session-tape.schema.json.
 * Zero external dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENGINE_ROOT = path.resolve(__dirname, '..');
const ROOT = process.cwd();
const TAPES_DIR = path.join(ROOT, '.exploratory/tapes');
const SCHEMA_PATH = fs.existsSync(path.join(ROOT, '.agents/domain/session-tape.schema.json'))
  ? path.join(ROOT, '.agents/domain/session-tape.schema.json')
  : path.join(ENGINE_ROOT, '.agents/domain/session-tape.schema.json');

if (!fs.existsSync(SCHEMA_PATH)) {
  console.error('❌ Missing schema file at .agents/domain/session-tape.schema.json');
  process.exit(1);
}

const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
const VALID_CHARTERS = new Set(schema.properties.charter.enum);
const VALID_ACTIONS = new Set(schema.properties.semanticSteps.items.properties.action.enum);
const VALID_STRATEGIES = new Set(
  schema.properties.semanticSteps.items.properties.locatorContract.properties.strategy.enum
);
const VALID_ASSERTIONS = new Set(
  schema.properties.expectedStates.items.properties.assertionType.enum
);
const VALID_CAPTURE_SOURCES = new Set(
  schema.properties.capturedVariables.items.properties.source.enum
);

const VALID_ROOT_KEYS = new Set(Object.keys(schema.properties));
const VALID_PERSONA_KEYS = new Set(Object.keys(schema.properties.persona.properties));
const VALID_ACTOR_KEYS = new Set(Object.keys(schema.properties.actors.items.properties));
const VALID_CAPTURED_VAR_KEYS = new Set(
  Object.keys(schema.properties.capturedVariables.items.properties)
);
const VALID_STEP_KEYS = new Set(Object.keys(schema.properties.semanticSteps.items.properties));
const VALID_LOCATOR_KEYS = new Set(
  Object.keys(schema.properties.semanticSteps.items.properties.locatorContract.properties)
);
const VALID_PARENT_SCOPE_KEYS = new Set(
  Object.keys(
    schema.properties.semanticSteps.items.properties.locatorContract.properties.parentScope.properties
  )
);
const VALID_NETWORK_KEYS = new Set(Object.keys(schema.properties.networkContracts.items.properties));
const VALID_STATE_KEYS = new Set(Object.keys(schema.properties.expectedStates.items.properties));
const VALID_RESUMES_FROM_KEYS = new Set(Object.keys(schema.properties.resumesFrom.properties));
const VALID_HANDOFF_STRATEGIES = new Set(
  schema.properties.resumesFrom.properties.handoffStrategy.enum
);

export const SAFE_MEMBER_REF_REGEX = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*(\(\))?)*$/;
export const SAFE_CLASS_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const SAFE_JSON_PATH_REGEX = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
export const SAFE_STORAGE_STATE_REGEX = /^\.auth\/[a-z0-9_-]+\.json$/;
export const SAFE_CHECKPOINT_PATH_REGEX = /^\.exploratory\/checkpoints\/[a-z0-9-]+\.json$/;
export const FORBIDDEN_IDENTIFIERS = new Set([
  '__proto__',
  'prototype',
  'constructor',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);
const MAX_TAPE_FILE_BYTES = 1024 * 1024; // 1 MB cap

const FORBIDDEN_METADATA_HOSTS = new Set([
  '0.0.0.0',
  '[::]',
  '169.254.169.254',
  '169.254.170.2',
  '100.100.100.200',
  '[fd00:ec2::254]',
  'metadata.google.internal',
  'metadata.azure.com',
  'metadata',
  'instance-data',
]);

export function hasForbiddenIdentifierSegment(rawExpr) {
  if (typeof rawExpr !== 'string') return true;
  const cleaned = rawExpr.replace(/^capturedVariable:/, '').replace(/\(\)/g, '');
  return cleaned.split('.').some((seg) => FORBIDDEN_IDENTIFIERS.has(seg));
}

export function isSafeMemberRef(rawExpr) {
  return (
    typeof rawExpr === 'string' &&
    SAFE_MEMBER_REF_REGEX.test(rawExpr) &&
    !hasForbiddenIdentifierSegment(rawExpr)
  );
}

export function isSafeClassName(rawName) {
  return (
    typeof rawName === 'string' &&
    SAFE_CLASS_NAME_REGEX.test(rawName) &&
    !FORBIDDEN_IDENTIFIERS.has(rawName)
  );
}

export const SENSITIVE_FIELD_REGEX =
  /(?:password|passcode|\bpin\b|user[_-]?pin|card[_-]?pin|\botp\b|cvv|cvc|\bssn\b|secret|client[_-]?secret|private[_-]?key|access[_-]?key|api[_-]?key|auth[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|bearer[_-]?token|\btoken\b)/i;

export const QUERY_SECRET_PARAM_REGEX =
  /[?&](?:password|passcode|pin|otp|cvv|cvc|ssn|secret|client[_-]?secret|api[_-]?key|access[_-]?key|private[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|token|bearer)=[^&\s]+/i;

export function hasQuerySecretParam(rawUrlOrPath) {
  return typeof rawUrlOrPath === 'string' && QUERY_SECRET_PARAM_REGEX.test(rawUrlOrPath);
}

export function isValidHttpUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    if (hasQuerySecretParam(rawUrl)) return false;
    const hostLower = parsed.hostname.toLowerCase();
    if (
      FORBIDDEN_METADATA_HOSTS.has(hostLower) ||
      /^169\.254\./.test(hostLower) ||
      /^\[(?:0*:)*ffff:(?:a9fe:|169\.254\.)/i.test(hostLower) ||
      /^\[fe80:/i.test(hostLower)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function checkUnknownKeys(obj, allowedSet, contextLabel, errorsList) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  for (const key of Object.getOwnPropertyNames(obj)) {
    if (FORBIDDEN_IDENTIFIERS.has(key)) {
      errorsList.push(`${contextLabel} Forbidden prototype property '${key}' is not allowed.`);
    } else if (!allowedSet.has(key)) {
      errorsList.push(`${contextLabel} Unknown property '${key}' is not allowed by session-tape.schema.json.`);
    }
  }
}

export function validateTapeObject(tape, file = 'session-tape.json', { expectedScenarioId } = {}) {
  const errors = [];
  if (!tape || typeof tape !== 'object' || Array.isArray(tape)) {
    errors.push(`[${file}] Session Tape root must be a JSON object.`);
    return errors;
  }

  checkUnknownKeys(tape, VALID_ROOT_KEYS, `[${file}]`, errors);

  for (const reqField of schema.required) {
    if (tape[reqField] === undefined) {
      errors.push(`[${file}] Missing required root field '${reqField}'.`);
    }
  }

  if (tape.schemaVersion !== '1.0.0') {
    errors.push(`[${file}] Unsupported schemaVersion '${tape.schemaVersion}' (expected '1.0.0').`);
  }

  const resolvedExpectedId = expectedScenarioId || path.basename(file, '.json');
  if (typeof tape.scenarioId !== 'string' || !/^[a-z0-9-]+$/.test(tape.scenarioId)) {
    errors.push(`[${file}] Invalid scenarioId '${tape.scenarioId}'. Must match ^[a-z0-9-]+$.`);
  } else if (resolvedExpectedId && tape.scenarioId !== resolvedExpectedId) {
    errors.push(
      `[${file}] scenarioId '${tape.scenarioId}' must match filename '${resolvedExpectedId}'.`
    );
  }

  if (typeof tape.baseUrl !== 'string' || !isValidHttpUrl(tape.baseUrl)) {
    errors.push(
      `[${file}] Invalid baseUrl '${tape.baseUrl}'. Must be a safe http(s):// URL without embedded credentials or secret query params.`
    );
  }
  if (
    tape.apiBaseUrl !== undefined &&
    (typeof tape.apiBaseUrl !== 'string' || !isValidHttpUrl(tape.apiBaseUrl))
  ) {
    errors.push(
      `[${file}] Invalid apiBaseUrl '${tape.apiBaseUrl}'. Must be a safe http(s):// URL without embedded credentials or secret query params.`
    );
  }

  if (!VALID_CHARTERS.has(tape.charter)) {
    errors.push(`[${file}] Invalid charter '${tape.charter}'.`);
  }

  if (tape.persona && typeof tape.persona === 'object') {
    checkUnknownKeys(tape.persona, VALID_PERSONA_KEYS, `[${file} persona]`, errors);
    if (!isSafeMemberRef(tape.persona.dataBuilderRef)) {
      errors.push(
        `[${file}] Invalid persona.dataBuilderRef '${tape.persona.dataBuilderRef}'. Must be a valid Data Builder reference.`
      );
    }
    if (
      tape.persona.storageStatePath !== undefined &&
      (typeof tape.persona.storageStatePath !== 'string' ||
        !SAFE_STORAGE_STATE_REGEX.test(tape.persona.storageStatePath))
    ) {
      errors.push(
        `[${file}] Invalid persona.storageStatePath '${tape.persona.storageStatePath}'. Must reside in .auth/<persona>.json.`
      );
    }
  }

  const declaredActors = new Set();
  if (tape.actors !== undefined) {
    if (!Array.isArray(tape.actors)) {
      errors.push(`[${file}] actors must be an array when provided.`);
    } else {
      for (const actor of tape.actors) {
        checkUnknownKeys(actor, VALID_ACTOR_KEYS, `[${file} actor]`, errors);
        if (
          !actor.actorId ||
          !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(actor.actorId) ||
          FORBIDDEN_IDENTIFIERS.has(actor.actorId)
        ) {
          errors.push(`[${file}] Invalid actor.actorId '${actor.actorId}'.`);
        } else {
          declaredActors.add(actor.actorId);
        }
        if (typeof actor.portalBaseUrl !== 'string' || !isValidHttpUrl(actor.portalBaseUrl)) {
          errors.push(`[${file}] Invalid actor.portalBaseUrl '${actor.portalBaseUrl}'.`);
        }
        if (actor.apiBaseUrl !== undefined && (typeof actor.apiBaseUrl !== 'string' || !isValidHttpUrl(actor.apiBaseUrl))) {
          errors.push(`[${file}] Invalid actor.apiBaseUrl '${actor.apiBaseUrl}'.`);
        }
        if (!isSafeMemberRef(actor.dataBuilderRef)) {
          errors.push(`[${file}] Invalid actor.dataBuilderRef '${actor.dataBuilderRef}'.`);
        }
        if (
          actor.storageStatePath !== undefined &&
          (typeof actor.storageStatePath !== 'string' ||
            !SAFE_STORAGE_STATE_REGEX.test(actor.storageStatePath))
        ) {
          errors.push(`[${file}] Invalid actor.storageStatePath '${actor.storageStatePath}'.`);
        }
      }
    }
  }

  if (tape.tags !== undefined) {
    if (!Array.isArray(tape.tags) || tape.tags.some((t) => typeof t !== 'string' || !/^@[a-z0-9-]+$/.test(t))) {
      errors.push(`[${file}] tags must be an array of '@kebab-case' strings (e.g. '@p0', '@smoke').`);
    }
  }

  if (tape.resumesFrom !== undefined) {
    if (!tape.resumesFrom || typeof tape.resumesFrom !== 'object' || Array.isArray(tape.resumesFrom)) {
      errors.push(`[${file}] resumesFrom must be an object when provided.`);
    } else {
      const rf = tape.resumesFrom;
      checkUnknownKeys(rf, VALID_RESUMES_FROM_KEYS, `[${file} resumesFrom]`, errors);
      if (rf.scenarioId !== undefined) {
        if (typeof rf.scenarioId !== 'string' || !/^[a-z0-9-]+$/.test(rf.scenarioId)) {
          errors.push(`[${file}] Invalid resumesFrom.scenarioId '${rf.scenarioId}'. Must match ^[a-z0-9-]+$.`);
        } else if (rf.scenarioId === tape.scenarioId) {
          errors.push(`[${file}] resumesFrom.scenarioId '${rf.scenarioId}' cannot reference itself.`);
        }
      }
      if (rf.specFile !== undefined) {
        if (
          typeof rf.specFile !== 'string' ||
          !rf.specFile.trim() ||
          rf.specFile.includes('..') ||
          path.isAbsolute(rf.specFile) ||
          !/^tests\/[a-zA-Z0-9_./-]+\.spec\.ts$/.test(rf.specFile)
        ) {
          errors.push(
            `[${file}] Invalid resumesFrom.specFile '${rf.specFile}'. Must be a safe relative path under tests/*.spec.ts.`
          );
        }
      }
      if (rf.resumeStep !== undefined && (typeof rf.resumeStep !== 'string' || rf.resumeStep.trim().length < 3)) {
        errors.push(`[${file}] resumesFrom.resumeStep must be a string with at least 3 characters.`);
      }
      if (rf.handoffStrategy !== undefined && !VALID_HANDOFF_STRATEGIES.has(rf.handoffStrategy)) {
        errors.push(
          `[${file}] Invalid resumesFrom.handoffStrategy '${rf.handoffStrategy}'. Must be one of: api-seed, checkpoint-state, ui-prereq.`
        );
      }
      if (rf.seedClientRef !== undefined && !isSafeMemberRef(rf.seedClientRef)) {
        errors.push(
          `[${file}] Invalid resumesFrom.seedClientRef '${rf.seedClientRef}'. Must be a safe ApiClient/Builder member reference.`
        );
      }
      if (
        rf.checkpointPath !== undefined &&
        (typeof rf.checkpointPath !== 'string' || !SAFE_CHECKPOINT_PATH_REGEX.test(rf.checkpointPath))
      ) {
        errors.push(
          `[${file}] Invalid resumesFrom.checkpointPath '${rf.checkpointPath}'. Must match .exploratory/checkpoints/<scenario-id>.json.`
        );
      }
      if (rf.handoffStrategy === 'api-seed' && !rf.seedClientRef && !rf.scenarioId) {
        errors.push(
          `[${file}] resumesFrom with handoffStrategy 'api-seed' requires either seedClientRef or scenarioId.`
        );
      }
    }
  }

  const declaredVars = new Set();
  if (tape.capturedVariables !== undefined) {
    if (!Array.isArray(tape.capturedVariables)) {
      errors.push(`[${file}] capturedVariables must be an array when provided.`);
    } else {
      for (const cv of tape.capturedVariables) {
        checkUnknownKeys(cv, VALID_CAPTURED_VAR_KEYS, `[${file} capturedVariables]`, errors);
        if (
          !cv.name ||
          !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(cv.name) ||
          FORBIDDEN_IDENTIFIERS.has(cv.name)
        ) {
          errors.push(`[${file}] capturedVariables entry has invalid name '${cv.name}'.`);
        } else {
          declaredVars.add(cv.name);
        }
        if (!VALID_CAPTURE_SOURCES.has(cv.source)) {
          errors.push(`[${file}] capturedVariables '${cv.name}' has invalid source '${cv.source}'.`);
        }
        if (
          cv.jsonPath !== undefined &&
          (typeof cv.jsonPath !== 'string' ||
            !SAFE_JSON_PATH_REGEX.test(cv.jsonPath) ||
            hasForbiddenIdentifierSegment(cv.jsonPath))
        ) {
          errors.push(
            `[${file}] capturedVariables '${cv.name}' has invalid jsonPath '${cv.jsonPath}'.`
          );
        }
        const isSensitiveCapture =
          /(?:password|passcode|\bpin\b|user[_-]?pin|card[_-]?pin|\botp\b|cvv|cvc|\bssn\b|secret|client[_-]?secret|private[_-]?key|access[_-]?key|api[_-]?key)/i.test(
            `${cv.name || ''} ${cv.jsonPath || ''}`
          );
        if (isSensitiveCapture) {
          errors.push(
            `[${file}] capturedVariables '${cv.name}' targets a sensitive credential field. Do not capture passwords, PINs, OTPs, CVVs, or secret keys into runtime spec variables.`
          );
        }
      }
    }
  }

  if (!Array.isArray(tape.semanticSteps) || tape.semanticSteps.length === 0) {
    errors.push(`[${file}] semanticSteps must be a non-empty array.`);
  } else {
    for (const step of tape.semanticSteps) {
      const stepLabel = `[${file} step #${step.stepIndex}]`;
      const isPasswordTarget =
        SENSITIVE_FIELD_REGEX.test(step.intent ?? '') ||
        SENSITIVE_FIELD_REGEX.test(step.locatorContract?.value ?? '');
      if (step.action === 'fill' && isPasswordTarget && step.inputData !== undefined) {
        errors.push(
          `${stepLabel} Raw secret 'inputData' is forbidden on sensitive credential fields (password/secret/token/apiKey/pin/passcode/otp/cvv/ssn). Use 'inputDataRef' referencing a Data Builder method.`
        );
      }

      checkUnknownKeys(step, VALID_STEP_KEYS, stepLabel, errors);

      if (step.actor !== undefined) {
        if (
          typeof step.actor !== 'string' ||
          !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(step.actor) ||
          FORBIDDEN_IDENTIFIERS.has(step.actor)
        ) {
          errors.push(`${stepLabel} Invalid step.actor '${step.actor}'.`);
        } else if (declaredActors.size > 0 && !declaredActors.has(step.actor)) {
          errors.push(`${stepLabel} step.actor '${step.actor}' is not declared in root actors.`);
        }
      }
      if (step.portalUrl !== undefined && (typeof step.portalUrl !== 'string' || !isValidHttpUrl(step.portalUrl))) {
        errors.push(`${stepLabel} Invalid step.portalUrl '${step.portalUrl}'. Must be a safe http(s):// URL.`);
      }
      if (step.pageRoute !== undefined && hasQuerySecretParam(step.pageRoute)) {
        errors.push(`${stepLabel} step.pageRoute '${step.pageRoute}' contains a secret query parameter.`);
      }
      if (step.conditionRef !== undefined && !isSafeMemberRef(step.conditionRef)) {
        errors.push(`${stepLabel} Invalid step.conditionRef '${step.conditionRef}'. Must be a safe Data Builder reference.`);
      }

      if (!VALID_ACTIONS.has(step.action)) {
        errors.push(`${stepLabel} Invalid action '${step.action}'.`);
      }
      if (step.action === 'press' && (typeof step.key !== 'string' || !step.key.trim())) {
        errors.push(`${stepLabel} Action 'press' requires a non-empty 'key' (e.g., 'Enter', 'Tab').`);
      }
      if (!isSafeClassName(step.componentCandidate)) {
        errors.push(
          `${stepLabel} Invalid componentCandidate '${step.componentCandidate}'. Must be a valid class identifier.`
        );
      }
      if (step.inputDataRef !== undefined && !isSafeMemberRef(step.inputDataRef)) {
        errors.push(
          `${stepLabel} Invalid inputDataRef '${step.inputDataRef}'. Must be a safe Data Builder member reference.`
        );
      }
      if (!step.locatorContract || !VALID_STRATEGIES.has(step.locatorContract.strategy)) {
        errors.push(`${stepLabel} Invalid or missing locatorContract.strategy.`);
      } else {
        checkUnknownKeys(step.locatorContract, VALID_LOCATOR_KEYS, `${stepLabel} locatorContract`, errors);
        if (step.locatorContract.parentScope) {
          checkUnknownKeys(
            step.locatorContract.parentScope,
            VALID_PARENT_SCOPE_KEYS,
            `${stepLabel} parentScope`,
            errors
          );
          if (
            step.locatorContract.parentScope.filterTextRef !== undefined &&
            !isSafeMemberRef(step.locatorContract.parentScope.filterTextRef)
          ) {
            errors.push(
              `${stepLabel} Invalid parentScope.filterTextRef '${step.locatorContract.parentScope.filterTextRef}'.`
            );
          }
        }
        if (step.action === 'goto' || step.locatorContract.strategy === 'url') {
          const navVal = String(step.locatorContract.value ?? '');
          const isSafeRelative =
            navVal.startsWith('/') && !navVal.startsWith('//') && !hasQuerySecretParam(navVal);
          if (!isSafeRelative && !isValidHttpUrl(navVal)) {
            errors.push(
              `${stepLabel} Unsafe navigation URL '${navVal}'. Must be a root-relative path ('/...') or safe http(s):// URL without secret query parameters.`
            );
          }
        }
        if (step.action === 'apiCall' || step.locatorContract.strategy === 'apiEndpoint') {
          const epVal = String(step.locatorContract.value ?? '');
          const isSafeRelative =
            epVal.startsWith('/') && !epVal.startsWith('//') && !hasQuerySecretParam(epVal);
          if (!isSafeRelative && !isValidHttpUrl(epVal)) {
            errors.push(
              `${stepLabel} Unsafe apiEndpoint URL '${epVal}'. Must be a root-relative path ('/api/...') or safe http(s):// URL without secret query parameters.`
            );
          }
        }
      }
      if (/^e\d+$/.test(step.locatorContract?.value ?? '')) {
        errors.push(
          `${stepLabel} Ephemeral CLI ref '${step.locatorContract.value}' leaked into locatorContract.value!`
        );
      }
      if (step.capturesVariable !== undefined) {
        if (
          typeof step.capturesVariable !== 'string' ||
          !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(step.capturesVariable) ||
          FORBIDDEN_IDENTIFIERS.has(step.capturesVariable)
        ) {
          errors.push(
            `${stepLabel} Invalid capturesVariable '${step.capturesVariable}'. Must be a safe identifier.`
          );
        } else if (declaredVars.size > 0 && !declaredVars.has(step.capturesVariable)) {
          errors.push(
            `${stepLabel} capturesVariable '${step.capturesVariable}' is not declared in root capturedVariables.`
          );
        }
      }
    }
  }

  if (Array.isArray(tape.networkContracts)) {
    for (const nc of tape.networkContracts) {
      checkUnknownKeys(nc, VALID_NETWORK_KEYS, `[${file} networkContracts]`, errors);
      if (hasQuerySecretParam(nc.urlPattern)) {
        errors.push(
          `[${file}] networkContracts.urlPattern '${nc.urlPattern}' contains a secret query parameter (?api_key=, ?token=, ?password=, etc.).`
        );
      }
      if (nc.clientCandidate !== undefined && !isSafeClassName(nc.clientCandidate)) {
        errors.push(`[${file}] Invalid networkContracts.clientCandidate '${nc.clientCandidate}'.`);
      }
      if (nc.requestBuilderRef !== undefined && !isSafeMemberRef(nc.requestBuilderRef)) {
        errors.push(`[${file}] Invalid networkContracts.requestBuilderRef '${nc.requestBuilderRef}'.`);
      }
      if (
        nc.method !== undefined &&
        !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(nc.method))
      ) {
        errors.push(`[${file}] Invalid networkContracts.method '${nc.method}'.`);
      }
    }
  }

  const rawTapeText = JSON.stringify(tape);
  if (
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bsk-[A-Za-z0-9_-]{20,}\b|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{35}\b|\bxox[baprs]-[0-9A-Za-z-]{10,}\b|\bnpm_[A-Za-z0-9]{36}\b|\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:Bearer\s+)?eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|mssql|amqp|amqps):\/\/[^/\s:@'"`]+:[^/\s@'"`]+@/i.test(
      rawTapeText
    )
  ) {
    errors.push(
      `[${file}] Session Tape contains a raw credential/token pattern. Reference environment-backed Data Builders via 'inputDataRef' instead.`
    );
  }
  if (/[\u202A-\u202E\u2066-\u2069]/.test(rawTapeText)) {
    errors.push(
      `[${file}] Session Tape contains Trojan-Source bidirectional Unicode control characters.`
    );
  }

  if (!Array.isArray(tape.expectedStates) || tape.expectedStates.length === 0) {
    errors.push(`[${file}] expectedStates must be a non-empty array.`);
  } else {
    for (const state of tape.expectedStates) {
      checkUnknownKeys(state, VALID_STATE_KEYS, `[${file} expectedStates]`, errors);
      if (!VALID_ASSERTIONS.has(state.assertionType)) {
        errors.push(`[${file}] Invalid assertionType '${state.assertionType}'.`);
      }
      if (!isSafeMemberRef(state.targetComponent)) {
        errors.push(`[${file}] Invalid expectedStates.targetComponent '${state.targetComponent}'.`);
      }
      if (!isSafeMemberRef(state.targetProperty)) {
        errors.push(`[${file}] Invalid expectedStates.targetProperty '${state.targetProperty}'.`);
      }
      const isCapturedVarRef =
        typeof state.expectedValueRef === 'string' &&
        /^capturedVariable:[a-zA-Z][a-zA-Z0-9_]*$/.test(state.expectedValueRef) &&
        !hasForbiddenIdentifierSegment(state.expectedValueRef);
      if (
        typeof state.expectedValueRef !== 'string' ||
        (!isCapturedVarRef && !isSafeMemberRef(state.expectedValueRef))
      ) {
        errors.push(`[${file}] Invalid expectedStates.expectedValueRef '${state.expectedValueRef}'.`);
      }
    }
  }

  return errors;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!fs.existsSync(TAPES_DIR)) {
    console.log('ℹ️ No .exploratory/tapes directory found. Skipping tape validation.');
    process.exit(0);
  }

  const tapeFiles = fs
    .readdirSync(TAPES_DIR, { withFileTypes: true })
    .filter((e) => !e.isSymbolicLink() && e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name);
  let errors = [];

  for (const file of tapeFiles) {
    const fullPath = path.join(TAPES_DIR, file);
    let tape;
    try {
      const stat = fs.lstatSync(fullPath);
      if (stat.size > MAX_TAPE_FILE_BYTES) {
        errors.push(`[${file}] Session Tape exceeds maximum allowed file size (${MAX_TAPE_FILE_BYTES} bytes).`);
        continue;
      }
      tape = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    } catch (err) {
      errors.push(`[${file}] Invalid JSON: ${err.message}`);
      continue;
    }

    errors.push(...validateTapeObject(tape, file));
  }

  if (errors.length > 0) {
    console.error('\n❌ Session Tape Validation Failed:\n');
    for (const e of errors) {
      console.error(`  - ${e}`);
    }
    process.exit(1);
  }

  console.log(`✅ Session Tape Validation Passed (${tapeFiles.length} tape(s) verified against session-tape.schema.json).`);
}

