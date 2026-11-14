#!/usr/bin/env node
/**
 * Validates all JSON Session Tapes in .exploratory/tapes/ against .agents/domain/session-tape.schema.json.
 * Zero external dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TAPES_DIR = path.join(ROOT, '.exploratory/tapes');
const SCHEMA_PATH = path.join(ROOT, '.agents/domain/session-tape.schema.json');

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

const SAFE_MEMBER_REF_REGEX = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*(\(\))?)*$/;
const SAFE_CLASS_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_STORAGE_STATE_REGEX = /^\.auth\/[a-z0-9_-]+\.json$/;
const MAX_TAPE_FILE_BYTES = 1024 * 1024; // 1 MB cap

const FORBIDDEN_METADATA_HOSTS = new Set([
  '169.254.169.254',
  '169.254.170.2',
  '100.100.100.200',
  '[fd00:ec2::254]',
  'metadata.google.internal',
  'metadata.azure.com',
  'metadata',
]);

function isValidHttpUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    const hostLower = parsed.hostname.toLowerCase();
    if (FORBIDDEN_METADATA_HOSTS.has(hostLower) || /^169\.254\./.test(hostLower)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function checkUnknownKeys(obj, allowedSet, contextLabel, errorsList) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      errorsList.push(`${contextLabel} Unknown property '${key}' is not allowed by session-tape.schema.json.`);
    }
  }
}

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

  checkUnknownKeys(tape, VALID_ROOT_KEYS, `[${file}]`, errors);

  for (const reqField of schema.required) {
    if (tape[reqField] === undefined) {
      errors.push(`[${file}] Missing required root field '${reqField}'.`);
    }
  }

  if (tape.schemaVersion !== '1.0.0') {
    errors.push(`[${file}] Unsupported schemaVersion '${tape.schemaVersion}' (expected '1.0.0').`);
  }

  const expectedScenarioId = path.basename(file, '.json');
  if (typeof tape.scenarioId !== 'string' || !/^[a-z0-9-]+$/.test(tape.scenarioId)) {
    errors.push(`[${file}] Invalid scenarioId '${tape.scenarioId}'. Must match ^[a-z0-9-]+$.`);
  } else if (tape.scenarioId !== expectedScenarioId) {
    errors.push(
      `[${file}] scenarioId '${tape.scenarioId}' must match filename '${expectedScenarioId}'.`
    );
  }

  if (typeof tape.baseUrl !== 'string' || !isValidHttpUrl(tape.baseUrl)) {
    errors.push(`[${file}] Invalid baseUrl '${tape.baseUrl}'. Must be an http:// or https:// URL.`);
  }
  if (
    tape.apiBaseUrl !== undefined &&
    (typeof tape.apiBaseUrl !== 'string' || !isValidHttpUrl(tape.apiBaseUrl))
  ) {
    errors.push(
      `[${file}] Invalid apiBaseUrl '${tape.apiBaseUrl}'. Must be an http:// or https:// URL.`
    );
  }

  if (!VALID_CHARTERS.has(tape.charter)) {
    errors.push(`[${file}] Invalid charter '${tape.charter}'.`);
  }

  if (tape.persona && typeof tape.persona === 'object') {
    checkUnknownKeys(tape.persona, VALID_PERSONA_KEYS, `[${file} persona]`, errors);
    if (
      typeof tape.persona.dataBuilderRef !== 'string' ||
      !SAFE_MEMBER_REF_REGEX.test(tape.persona.dataBuilderRef)
    ) {
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
        if (!actor.actorId || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(actor.actorId)) {
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
        if (
          typeof actor.dataBuilderRef !== 'string' ||
          !SAFE_MEMBER_REF_REGEX.test(actor.dataBuilderRef)
        ) {
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

  const declaredVars = new Set();
  if (tape.capturedVariables !== undefined) {
    if (!Array.isArray(tape.capturedVariables)) {
      errors.push(`[${file}] capturedVariables must be an array when provided.`);
    } else {
      for (const cv of tape.capturedVariables) {
        if (!cv.name || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(cv.name)) {
          errors.push(`[${file}] capturedVariables entry has invalid name '${cv.name}'.`);
        } else {
          declaredVars.add(cv.name);
        }
        if (!VALID_CAPTURE_SOURCES.has(cv.source)) {
          errors.push(`[${file}] capturedVariables '${cv.name}' has invalid source '${cv.source}'.`);
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
        /password|secret|token|api[_-]?key/i.test(step.intent ?? '') ||
        /password|secret|token|api[_-]?key/i.test(step.locatorContract?.value ?? '');
      if (step.action === 'fill' && isPasswordTarget && step.inputData !== undefined) {
        errors.push(
          `${stepLabel} Raw secret 'inputData' is forbidden on password/secret fields. Use 'inputDataRef' referencing a Data Builder method (e.g. 'UserBuilder.standardUser().password').`
        );
      }

      checkUnknownKeys(step, VALID_STEP_KEYS, stepLabel, errors);

      if (step.actor !== undefined) {
        if (typeof step.actor !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(step.actor)) {
          errors.push(`${stepLabel} Invalid step.actor '${step.actor}'.`);
        } else if (declaredActors.size > 0 && !declaredActors.has(step.actor)) {
          errors.push(`${stepLabel} step.actor '${step.actor}' is not declared in root actors.`);
        }
      }
      if (step.portalUrl !== undefined && (typeof step.portalUrl !== 'string' || !isValidHttpUrl(step.portalUrl))) {
        errors.push(`${stepLabel} Invalid step.portalUrl '${step.portalUrl}'. Must be an http(s):// URL.`);
      }
      if (
        step.conditionRef !== undefined &&
        (typeof step.conditionRef !== 'string' || !SAFE_MEMBER_REF_REGEX.test(step.conditionRef))
      ) {
        errors.push(`${stepLabel} Invalid step.conditionRef '${step.conditionRef}'. Must be a safe Data Builder reference.`);
      }

      if (!VALID_ACTIONS.has(step.action)) {
        errors.push(`${stepLabel} Invalid action '${step.action}'.`);
      }
      if (step.action === 'press' && (typeof step.key !== 'string' || !step.key.trim())) {
        errors.push(`${stepLabel} Action 'press' requires a non-empty 'key' (e.g., 'Enter', 'Tab').`);
      }
      if (
        typeof step.componentCandidate !== 'string' ||
        !SAFE_CLASS_NAME_REGEX.test(step.componentCandidate)
      ) {
        errors.push(
          `${stepLabel} Invalid componentCandidate '${step.componentCandidate}'. Must be a valid class identifier.`
        );
      }
      if (
        step.inputDataRef !== undefined &&
        (typeof step.inputDataRef !== 'string' || !SAFE_MEMBER_REF_REGEX.test(step.inputDataRef))
      ) {
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
            (typeof step.locatorContract.parentScope.filterTextRef !== 'string' ||
              !SAFE_MEMBER_REF_REGEX.test(step.locatorContract.parentScope.filterTextRef))
          ) {
            errors.push(
              `${stepLabel} Invalid parentScope.filterTextRef '${step.locatorContract.parentScope.filterTextRef}'.`
            );
          }
        }
        if (step.action === 'goto' || step.locatorContract.strategy === 'url') {
          const navVal = String(step.locatorContract.value ?? '');
          const isSafeRelative = navVal.startsWith('/') && !navVal.startsWith('//');
          if (!isSafeRelative && !isValidHttpUrl(navVal)) {
            errors.push(
              `${stepLabel} Unsafe navigation URL '${navVal}'. Must be a root-relative path ('/...') or http(s):// URL.`
            );
          }
        }
      }
      if (/^e\d+$/.test(step.locatorContract?.value ?? '')) {
        errors.push(
          `${stepLabel} Ephemeral CLI ref '${step.locatorContract.value}' leaked into locatorContract.value!`
        );
      }
      if (step.capturesVariable && declaredVars.size > 0 && !declaredVars.has(step.capturesVariable)) {
        errors.push(
          `${stepLabel} capturesVariable '${step.capturesVariable}' is not declared in root capturedVariables.`
        );
      }
    }
  }

  if (Array.isArray(tape.networkContracts)) {
    for (const nc of tape.networkContracts) {
      checkUnknownKeys(nc, VALID_NETWORK_KEYS, `[${file} networkContracts]`, errors);
      if (nc.clientCandidate !== undefined && (typeof nc.clientCandidate !== 'string' || !SAFE_CLASS_NAME_REGEX.test(nc.clientCandidate))) {
        errors.push(`[${file}] Invalid networkContracts.clientCandidate '${nc.clientCandidate}'.`);
      }
      if (nc.requestBuilderRef !== undefined && (typeof nc.requestBuilderRef !== 'string' || !SAFE_MEMBER_REF_REGEX.test(nc.requestBuilderRef))) {
        errors.push(`[${file}] Invalid networkContracts.requestBuilderRef '${nc.requestBuilderRef}'.`);
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
      if (
        typeof state.targetComponent !== 'string' ||
        !SAFE_MEMBER_REF_REGEX.test(state.targetComponent)
      ) {
        errors.push(`[${file}] Invalid expectedStates.targetComponent '${state.targetComponent}'.`);
      }
      if (
        typeof state.targetProperty !== 'string' ||
        !SAFE_MEMBER_REF_REGEX.test(state.targetProperty)
      ) {
        errors.push(`[${file}] Invalid expectedStates.targetProperty '${state.targetProperty}'.`);
      }
      const isCapturedVarRef =
        typeof state.expectedValueRef === 'string' &&
        /^capturedVariable:[a-zA-Z][a-zA-Z0-9_]*$/.test(state.expectedValueRef);
      if (
        typeof state.expectedValueRef !== 'string' ||
        (!isCapturedVarRef && !SAFE_MEMBER_REF_REGEX.test(state.expectedValueRef))
      ) {
        errors.push(`[${file}] Invalid expectedStates.expectedValueRef '${state.expectedValueRef}'.`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error('\n❌ Session Tape Validation Failed:\n');
  for (const e of errors) {
    console.error(`  - ${e}`);
  }
  process.exit(1);
}

console.log(`✅ Session Tape Validation Passed (${tapeFiles.length} tape(s) verified against session-tape.schema.json).`);
