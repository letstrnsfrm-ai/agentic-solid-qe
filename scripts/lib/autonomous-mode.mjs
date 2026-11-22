import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const AUTONOMOUS_SESSION_REL_PATH = '.agents/domain/autonomous-session.json';
export const AUTONOMOUS_LEDGER_REL_PATH = '.agents/domain/autonomous-decisions.md';
export const VALID_FOCUS_MODES = ['full', 'baseline', 'regression', 'migrate', 'heal'];
export const DEFAULT_CHECKIN_INTERVAL_MS = 60 * 60 * 1000; // 1h
export const MIN_INTERVAL_MS = 1000; // 1s (supports fast tests & custom intervals)
export const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
export const DEFAULT_MAX_CYCLES = 100;
export const DEFAULT_MAX_CONSECUTIVE_SHARD_FAILURES = 3;

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'our', 'all', 'test',
  'tests', 'testing', 'spec', 'specs', 'flow', 'flows', 'page', 'pages', 'route', 'routes',
  'ensure', 'verify', 'check', 'make', 'sure', 'goal', 'objective', 'objectives', 'auto',
]);

/**
 * Resolve a path safely inside `rootDir` (blocks traversal and symlinks).
 */
function resolveSafeInRoot(rootDir, relPath) {
  const resolvedRoot = path.resolve(rootDir);
  const full = path.resolve(resolvedRoot, relPath);
  const rel = path.relative(resolvedRoot, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Unsafe path outside workspace root: ${relPath}`);
  }
  if (fs.existsSync(full) && fs.lstatSync(full).isSymbolicLink()) {
    throw new Error(`Refusing to follow symlink at: ${relPath}`);
  }
  return full;
}

/**
 * Parse human duration strings like `30m`, `1h`, `2h`, `1.5h`, `90min`, `45s`, or plain minutes `30`.
 */
export function parseDurationMs(raw, { defaultMs = DEFAULT_CHECKIN_INTERVAL_MS, allowNull = false } = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return allowNull ? null : defaultMs;
  }
  const str = String(raw).trim().toLowerCase();
  const match = str.match(/^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/);
  if (!match) {
    throw new Error(
      `Invalid duration '${raw}'. Use formats like '30m', '1h', '2h', '90m', or '45s'.`
    );
  }
  const value = Number(match[1]);
  const unit = match[2] || 'm';
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Duration must be a positive number: '${raw}'.`);
  }
  let ms;
  if (unit === 'ms') ms = value;
  else if (unit.startsWith('s')) ms = value * 1000;
  else if (unit.startsWith('h')) ms = value * 60 * 60 * 1000;
  else ms = value * 60 * 1000;

  ms = Math.round(ms);
  if (ms < MIN_INTERVAL_MS || ms > MAX_INTERVAL_MS) {
    throw new Error(
      `Duration '${raw}' (${ms}ms) out of allowed bounds (${MIN_INTERVAL_MS}ms..${MAX_INTERVAL_MS}ms).`
    );
  }
  return ms;
}

/**
 * Format milliseconds into a concise human string (`30m`, `1h`, `1h 30m`, `45s`).
 */
export function formatDurationHuman(ms) {
  const safe = Math.max(0, Math.round(Number(ms) || 0));
  if (safe < 60_000) {
    return `${Math.max(1, Math.round(safe / 1000))}s`;
  }
  const totalMins = Math.round(safe / 60_000);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

export function normalizeFocus(raw) {
  const f = String(raw || 'full').trim().toLowerCase();
  if (!VALID_FOCUS_MODES.includes(f)) {
    throw new Error(`Invalid --focus '${raw}'. Expected one of: ${VALID_FOCUS_MODES.join(', ')}.`);
  }
  return f;
}

export function normalizeRoutes(raw) {
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : String(raw).split(',');
  return items
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .slice(0, 25);
}

export function loadAutonomousSession(rootDir = process.cwd()) {
  const sessionPath = resolveSafeInRoot(rootDir, AUTONOMOUS_SESSION_REL_PATH);
  if (!fs.existsSync(sessionPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse ${AUTONOMOUS_SESSION_REL_PATH}: ${err.message}`);
  }
}

export function saveAutonomousSession(rootDir = process.cwd(), session) {
  const sessionPath = resolveSafeInRoot(rootDir, AUTONOMOUS_SESSION_REL_PATH);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  session.updatedAt = new Date().toISOString();
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2) + '\n', 'utf8');
  return sessionPath;
}

function appendLedgerMarkdown(rootDir, block) {
  const ledgerPath = resolveSafeInRoot(rootDir, AUTONOMOUS_LEDGER_REL_PATH);
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const existing = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8') : '';
  const sep = existing && !existing.endsWith('\n\n') ? (existing.endsWith('\n') ? '\n' : '\n\n') : '';
  fs.writeFileSync(ledgerPath, existing + sep + block.trimEnd() + '\n', 'utf8');
  return ledgerPath;
}

/**
 * Initialize a new Fully Autonomous session with locked user objectives and check-in schedule.
 */
export function startAutonomousSession(
  rootDir = process.cwd(),
  {
    goal = 'Achieve verified SOLID automation coverage across target application shards',
    focus = 'full',
    interval = '1h',
    routes = [],
    squad = null,
    targetStage = 4,
    targetSpecs = null,
    maxRuntime = null,
    maxCycles = DEFAULT_MAX_CYCLES,
    baselineSnapshot = null,
    nowMs = Date.now(),
  } = {}
) {
  const normalizedFocus = normalizeFocus(focus);
  const intervalMs = parseDurationMs(interval, { defaultMs: DEFAULT_CHECKIN_INTERVAL_MS });
  const maxRuntimeMs = parseDurationMs(maxRuntime, { allowNull: true });
  const normalizedRoutes = normalizeRoutes(routes);
  const safeMaxCycles = Math.max(1, Math.min(500, Math.floor(Number(maxCycles) || DEFAULT_MAX_CYCLES)));
  const safeTargetSpecs =
    targetSpecs !== null && targetSpecs !== undefined && String(targetSpecs).trim() !== ''
      ? Math.max(1, Math.floor(Number(targetSpecs)))
      : null;

  const isoNow = new Date(nowMs).toISOString();
  const shortId = crypto.randomBytes(3).toString('hex');
  const sessionId = `auto-${isoNow.slice(0, 10).replace(/-/g, '')}-${shortId}`;

  const session = {
    schemaVersion: 1,
    sessionId,
    status: 'active',
    createdAt: isoNow,
    updatedAt: isoNow,
    startedAtMs: nowMs,
    lastCheckinAtMs: nowMs,
    nextCheckinAtMs: nowMs + intervalMs,
    checkinCount: 0,
    cycleCount: 0,
    objectives: {
      goal: String(goal || '').trim() || 'Achieve verified SOLID automation coverage',
      focus: normalizedFocus,
      routes: normalizedRoutes,
      squad: squad || null,
      targetStage: Math.max(1, Math.min(4, Math.floor(Number(targetStage) || 4))),
      targetSpecs: safeTargetSpecs,
    },
    schedule: {
      intervalLabel: formatDurationHuman(intervalMs),
      intervalMs,
      maxRuntimeMs,
      maxCycles: safeMaxCycles,
    },
    guardrails: {
      maxConsecutiveShardFailures: DEFAULT_MAX_CONSECUTIVE_SHARD_FAILURES,
      workspaceOnly: true,
    },
    failureCounts: {},
    quarantined: [],
    decisions: [],
    lastFingerprint: null,
    seenFingerprints: [],
    baselineSnapshot: baselineSnapshot || null,
    lastSnapshot: baselineSnapshot || null,
    lastCheckinDecisionIndex: 0,
  };

  const sessionPath = saveAutonomousSession(rootDir, session);
  const ledgerPath = resolveSafeInRoot(rootDir, AUTONOMOUS_LEDGER_REL_PATH);
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });

  const header = [
    `# Autonomous QE Decision Ledger`,
    ``,
    `- **Session ID:** \`${session.sessionId}\``,
    `- **Started:** \`${isoNow}\``,
    `- **Objective:** ${session.objectives.goal}`,
    `- **Focus:** \`${session.objectives.focus}\` | **Check-In Interval:** \`${session.schedule.intervalLabel}\` (soft pause)`,
    `- **Scope Routes:** ${normalizedRoutes.length > 0 ? normalizedRoutes.map((r) => `\`${r}\``).join(', ') : '*(all discovered shards)*'}`,
    `- **Guardrails:** workspace-only (no \`git push\`/PR), max ${session.guardrails.maxConsecutiveShardFailures} consecutive failures/shard -> quarantine, max ${session.schedule.maxCycles} cycles${maxRuntimeMs ? `, max runtime ${formatDurationHuman(maxRuntimeMs)}` : ''}`,
    ``,
    `---`,
    ``,
  ].join('\n');
  fs.writeFileSync(ledgerPath, header, 'utf8');

  return { session, sessionPath, ledgerPath };
}

/**
 * Resume a paused autonomous session after a check-in or resolved blocker, with optional objective steering.
 */
export function resumeAutonomousSession(
  rootDir = process.cwd(),
  { goal = null, focus = null, interval = null, routes = null, maxRuntime = null, maxCycles = null, nowMs = Date.now() } = {}
) {
  const session = loadAutonomousSession(rootDir);
  if (!session) {
    throw new Error('No autonomous session found. Start one with: npx cortex orchestrate --autonomous start --goal "<goal>" --interval 1h');
  }
  if (goal) session.objectives.goal = String(goal).trim();
  if (focus) session.objectives.focus = normalizeFocus(focus);
  if (routes !== null && routes !== undefined) session.objectives.routes = normalizeRoutes(routes);
  if (interval) {
    const ms = parseDurationMs(interval);
    session.schedule.intervalMs = ms;
    session.schedule.intervalLabel = formatDurationHuman(ms);
  }
  if (maxRuntime) {
    session.schedule.maxRuntimeMs = parseDurationMs(maxRuntime, { allowNull: true });
  } else if (session.schedule.maxRuntimeMs && nowMs - (session.startedAtMs || nowMs) >= session.schedule.maxRuntimeMs) {
    session.schedule.maxRuntimeMs += session.schedule.intervalMs || DEFAULT_CHECKIN_INTERVAL_MS;
  }
  if (maxCycles) {
    session.schedule.maxCycles = Math.max(1, Math.min(500, Math.floor(Number(maxCycles))));
  } else if (session.schedule.maxCycles && (session.cycleCount || 0) >= session.schedule.maxCycles) {
    session.schedule.maxCycles = Math.min(500, session.schedule.maxCycles + DEFAULT_MAX_CYCLES);
  }

  session.status = 'active';
  session.lastCheckinAtMs = nowMs;
  session.nextCheckinAtMs = nowMs + session.schedule.intervalMs;
  session.lastCheckinDecisionIndex = session.decisions.length;
  session.seenFingerprints = [];
  saveAutonomousSession(rootDir, session);

  appendLedgerMarkdown(
    rootDir,
    [
      `### ▶️ Check-In #${session.checkinCount} Resumed (\`${new Date(nowMs).toISOString()}\`)`,
      `- **Objective:** ${session.objectives.goal}`,
      `- **Focus:** \`${session.objectives.focus}\` | **Next Check-In:** in \`${session.schedule.intervalLabel}\``,
    ].join('\n')
  );

  return session;
}

/**
 * Cleanly stop an autonomous session.
 */
export function stopAutonomousSession(rootDir = process.cwd(), { reason = 'user-stopped', nowMs = Date.now() } = {}) {
  const session = loadAutonomousSession(rootDir);
  if (!session) {
    throw new Error('No autonomous session found to stop.');
  }
  session.status = 'stopped';
  session.stoppedReason = reason;
  saveAutonomousSession(rootDir, session);

  appendLedgerMarkdown(
    rootDir,
    [
      `### 🛑 Session Stopped (\`${new Date(nowMs).toISOString()}\`)`,
      `- **Reason:** ${reason}`,
      `- **Total Cycles:** ${session.cycleCount} | **Decisions Logged:** ${session.decisions.length} | **Quarantined:** ${session.quarantined.length}`,
    ].join('\n')
  );
  return session;
}

/**
 * Record an autonomous decision in both `autonomous-session.json` and `autonomous-decisions.md`.
 */
export function recordAutonomousDecision(rootDir, session, entry, { nowMs = Date.now() } = {}) {
  const decision = {
    cycle: entry.cycle ?? session.cycleCount,
    at: new Date(nowMs).toISOString(),
    gateId: entry.gateId || 'autonomous-step',
    skill: entry.skill || 'agentic-solid-qe',
    action: entry.action || 'auto-decided',
    chosenOptionId: entry.chosenOptionId || '',
    chosenLabel: entry.chosenLabel || '',
    command: entry.command || '',
    rationale: entry.rationale || '',
    alternatives: Array.isArray(entry.alternatives) ? entry.alternatives : [],
    outcome: entry.outcome || 'recorded',
  };
  session.decisions.push(decision);
  saveAutonomousSession(rootDir, session);

  const altText = decision.alternatives.length > 0 ? decision.alternatives.join(', ') : 'none';
  appendLedgerMarkdown(
    rootDir,
    [
      `#### Cycle #${decision.cycle} — \`/${decision.skill}\` (\`${decision.action}\`) · \`${decision.at}\``,
      `- **Decision:** ${decision.chosenLabel || decision.chosenOptionId || decision.command}`,
      decision.command ? `- **Command:** \`${decision.command}\`` : null,
      `- **Rationale:** ${decision.rationale}`,
      `- **Alternatives Considered:** ${altText}`,
      `- **Outcome:** \`${decision.outcome}\``,
    ]
      .filter(Boolean)
      .join('\n')
  );

  return decision;
}

/**
 * Quarantine a failing shard/spec/defect so the autonomous loop continues on remaining unblocked work.
 */
export function quarantineAutonomousItem(
  rootDir,
  session,
  { key, reason, category = 'repeated-failure', defectFile = null, nowMs = Date.now() }
) {
  const normKey = String(key || '').trim().toLowerCase();
  if (!normKey) throw new Error('Quarantine key is required.');
  const existing = session.quarantined.find((q) => q.key === normKey);
  if (!existing) {
    session.quarantined.push({
      key: normKey,
      reason: String(reason || 'Quarantined during autonomous execution'),
      category,
      ...(defectFile ? { defectFile } : {}),
      at: new Date(nowMs).toISOString(),
    });
  }
  saveAutonomousSession(rootDir, session);
  appendLedgerMarkdown(
    rootDir,
    [
      `> ⚠️ **Quarantined \`${normKey}\`** (\`${category}\`)${defectFile ? ` — see \`${defectFile}\`` : ''}`,
      `> Reason: ${reason}`,
    ].join('\n')
  );
  return session;
}

export function isItemQuarantined(session, candidate) {
  if (!session || !Array.isArray(session.quarantined) || session.quarantined.length === 0) return false;
  const hay = String(candidate || '').trim().toLowerCase();
  if (!hay) return false;
  const hayBare = hay.replace(/^(shard|spec|tape|option):/, '').replace(/\.md$/, '');
  const hayBase = path.basename(hayBare);
  return session.quarantined.some((q) => {
    const bare = q.key.replace(/^(shard|spec|tape|option):/, '').replace(/\.md$/, '');
    if (hay === q.key || hayBare === bare || hayBase === bare) return true;
    // Also match generated scenario IDs for a quarantined shard (e.g. `login-p0`, `--shard login`)
    const escaped = bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|--shard\\s+)${escaped}(?:-(?:p[0-2]|negative|a11y))?(?:$|\\s)`).test(hay);
  });
}

/**
 * Determine whether the current state is a hard blocker that MUST pause immediately.
 * Only MFA/CAPTCHA/auth expiry or unconfigured target URL qualify as hard blockers.
 */
export function detectHardBlocker(blueprint, triageReport = null) {
  const gateId = blueprint?.nextAction?.gatePayload?.gateId || '';
  if (gateId === 'stage0-target-url') {
    return {
      blocked: true,
      gateId,
      reason: 'Target application baseUrl is not configured. Provide --url via `npx cortex orchestrate --bootstrap --url <url> --name "<App>" --discover-shards`.',
    };
  }
  if (gateId === 'stage0-auth-session') {
    return {
      blocked: true,
      gateId,
      reason: `Interactive authentication / MFA / CAPTCHA required to save missing persona session(s): ${(blueprint?.targetApp?.missingAuthSessions || []).join(', ')}.`,
    };
  }
  if (triageReport?.rootCause?.category === 'auth-drift') {
    return {
      blocked: true,
      gateId: 'auth-drift-blocker',
      reason: 'Authentication session expired (auth-drift detected). Complete interactive login to refresh `.auth/<persona>.json`, then resume.',
    };
  }
  return { blocked: false, gateId: null, reason: null };
}

/**
 * Check schedule & guardrail limits (max runtime, max cycles, or check-in interval elapsed).
 */
export function checkAutonomousLimits(session, nowMs = Date.now()) {
  const elapsedMs = Math.max(0, nowMs - (session.startedAtMs || nowMs));
  const remainingCheckinMs = Math.max(0, (session.nextCheckinAtMs || nowMs) - nowMs);

  if (session.schedule?.maxRuntimeMs && elapsedMs >= session.schedule.maxRuntimeMs) {
    return {
      limitHit: true,
      type: 'max-runtime',
      elapsedMs,
      remainingCheckinMs: 0,
      message: `Maximum autonomous runtime (${formatDurationHuman(session.schedule.maxRuntimeMs)}) reached.`,
    };
  }
  if (session.schedule?.maxCycles && session.cycleCount >= session.schedule.maxCycles) {
    return {
      limitHit: true,
      type: 'max-cycles',
      elapsedMs,
      remainingCheckinMs,
      message: `Maximum autonomous cycle cap (${session.schedule.maxCycles}) reached.`,
    };
  }
  if (nowMs >= (session.nextCheckinAtMs || 0)) {
    return {
      limitHit: true,
      type: 'checkin-interval',
      elapsedMs,
      remainingCheckinMs: 0,
      message: `Scheduled ${session.schedule?.intervalLabel || '1h'} check-in interval reached — pausing for user progress review.`,
    };
  }
  return {
    limitHit: false,
    type: null,
    elapsedMs,
    remainingCheckinMs,
    message: null,
  };
}

/**
 * Extract significant keywords from a freeform user goal for option scoring.
 */
function extractGoalKeywords(goal) {
  return String(goal || '')
    .toLowerCase()
    .split(/[^a-z0-9/-]+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

/**
 * Rank `gatePayload.options` against the session's structured objectives (`focus`, `routes`, `goal`, `quarantined`).
 */
export function rankAndSelectGateOption(blueprint, session) {
  const next = blueprint?.nextAction || {};
  const options = Array.isArray(next.gatePayload?.options) ? next.gatePayload.options : [];
  const focus = session?.objectives?.focus || 'full';
  const routes = session?.objectives?.routes || [];
  const goalKeywords = extractGoalKeywords(session?.objectives?.goal || '');

  // If the blueprint targets an uncovered shard that is quarantined (or lower priority than a requested route),
  // inspect queuePreview.uncoveredShards for a better unquarantined shard.
  const uncovered = Array.isArray(blueprint?.queuePreview?.uncoveredShards)
    ? blueprint.queuePreview.uncoveredShards
    : [];
  const unquarantinedShards = uncovered.filter((s) => {
    const raw = typeof s === 'string' ? s : s?.shard || s?.feature || '';
    const slug = path.basename(String(raw), '.md').toLowerCase();
    return !isItemQuarantined(session, raw) && !isItemQuarantined(session, slug);
  });

  if (next.gatePayload?.gateId === 'stage1-scenario-selection') {
    const currentShard = next.gatePayload.shard || '';
    const routeMatchedShard =
      routes.length > 0
        ? unquarantinedShards.find((s) => {
            const raw = String(typeof s === 'string' ? s : s?.shard || s?.feature || '').toLowerCase();
            return routes.some((r) => raw.includes(r.replace(/^\/+/, '').toLowerCase()));
          })
        : null;

    if (isItemQuarantined(session, currentShard) || (routeMatchedShard && !String(routeMatchedShard).toLowerCase().includes(currentShard))) {
      const target = routeMatchedShard || unquarantinedShards[0];
      if (!target) {
        return { chosen: null, alternatives: [], rationale: 'All remaining uncovered shards are quarantined.', allQuarantined: true };
      }
      const rawPath = typeof target === 'string' ? target : target.shard || target.feature || 'main';
      const slug = path.basename(String(rawPath), '.md').replace(/[^a-z0-9-]/gi, '-').toLowerCase() || 'main';
      const scenarioSuffix = focus === 'regression' ? 'negative' : 'p0';
      const charter = focus === 'regression' ? 'boundary-analysis' : 'happy-path-baseline';
      const chosen = {
        id: `${slug}-${scenarioSuffix}`,
        label: `${focus === 'regression' ? '@p1 Boundary & Negative' : '(Recommended) @p0 Happy-Path Baseline'} on shard '${slug}' (${charter})`,
        charter,
        shard: slug,
        command: `npx cortex orchestrate --explore start --shard ${slug} --scenario ${slug}-${scenarioSuffix}`,
      };
      return {
        chosen,
        alternatives: options.map((o) => o.id),
        rationale: isItemQuarantined(session, currentShard)
          ? `Skipped quarantined shard '${currentShard}'; pivoted to next unblocked shard '${slug}' aligned with focus '${focus}'.`
          : `Prioritized shard '${slug}' matching requested route scope (${routes.join(', ')}) with focus '${focus}'.`,
        allQuarantined: false,
      };
    }
  }

  if (options.length === 0) {
    return {
      chosen: {
        id: next.skill || 'default-action',
        label: next.why || next.command || 'Execute next recommended action',
        command: next.command || '',
      },
      alternatives: [],
      rationale: `Single deterministic action available for /${next.skill || 'agentic-solid-qe'}.`,
      allQuarantined: false,
    };
  }

  const eligible = options.filter((o) => !isItemQuarantined(session, o.id) && !isItemQuarantined(session, o.command));
  if (eligible.length === 0) {
    return {
      chosen: null,
      alternatives: options.map((o) => o.id),
      rationale: 'All candidate gate options are currently quarantined.',
      allQuarantined: true,
    };
  }

  const scored = eligible.map((opt, idx) => {
    const text = `${opt.id || ''} ${opt.label || ''} ${opt.charter || ''} ${opt.command || ''}`.toLowerCase();
    let score = 0;
    const reasons = [];

    if (String(opt.label || '').includes('(Recommended)')) {
      score += 10;
    }

    // Focus alignment
    if (focus === 'baseline') {
      if (/@p0|happy-path|baseline|discover-shards|ci-init/.test(text)) {
        score += 30;
        reasons.push("matches focus 'baseline'");
      }
    } else if (focus === 'regression') {
      if (/@p1|boundary|negative|clone|regression|handoff/.test(text)) {
        score += 35;
        reasons.push("matches focus 'regression'");
      }
    } else if (focus === 'migrate') {
      if (/wave|migrat/.test(text)) {
        score += 35;
        reasons.push("matches focus 'migrate'");
      }
    } else if (focus === 'heal') {
      if (/heal-apply|heal|verify/.test(text)) {
        score += 35;
        reasons.push("matches focus 'heal'");
      }
    } else if (focus === 'full') {
      if (/(recommended)|@p0|happy-path|discover-shards|heal-apply|ci-init|clone/.test(text)) {
        score += 20;
        reasons.push("aligned with 'full' coverage progression");
      }
    }

    // Route scope match
    for (const r of routes) {
      const cleanRoute = r.replace(/^\/+/, '').toLowerCase();
      if (cleanRoute && text.includes(cleanRoute)) {
        score += 50;
        reasons.push(`matches route '${r}'`);
        break;
      }
    }

    // Goal keyword match
    const matchedKw = goalKeywords.filter((kw) => text.includes(kw));
    if (matchedKw.length > 0) {
      score += Math.min(25, matchedKw.length * 8);
      reasons.push(`matches goal keyword(s): ${matchedKw.slice(0, 3).join(', ')}`);
    }

    // Gentle preference for earlier option on ties
    score -= idx * 0.5;
    return { opt, score, reasons };
  });

  scored.sort((a, b) => b.score - a.score);
  const winner = scored[0];
  const alternatives = scored.slice(1).map((s) => s.opt.id || s.opt.label);
  const rationale =
    winner.reasons.length > 0
      ? `Selected '${winner.opt.id}' (${winner.reasons.join('; ')}).`
      : `Selected highest-ranked recommended option '${winner.opt.id}' for ${blueprint?.maturityStage || 'current stage'}.`;

  return {
    chosen: winner.opt,
    alternatives,
    rationale,
    allQuarantined: false,
  };
}

/**
 * Evaluate whether the session's stated objectives have been achieved.
 */
export function isObjectiveComplete(blueprint, session) {
  const h = blueprint?.healthSnapshot || {};
  const obj = session?.objectives || {};
  const focus = obj.focus || 'full';

  // Target spec count reached cleanly
  if (obj.targetSpecs && h.automatedSpecs >= obj.targetSpecs && h.uncompiledTapes === 0 && h.failingTestArtifacts === 0) {
    return {
      complete: true,
      reason: `Reached target spec count (${h.automatedSpecs}/${obj.targetSpecs}) with 0 uncompiled tapes and 0 failing artifacts.`,
    };
  }

  // Count remaining unquarantined uncovered shards
  const uncovered = Array.isArray(blueprint?.queuePreview?.uncoveredShards)
    ? blueprint.queuePreview.uncoveredShards
    : [];
  const activeUncovered = uncovered.filter((s) => {
    const raw = typeof s === 'string' ? s : s?.shard || s?.feature || '';
    const slug = path.basename(String(raw), '.md').toLowerCase();
    return !isItemQuarantined(session, raw) && !isItemQuarantined(session, slug);
  });

  if (focus === 'heal' && h.failingTestArtifacts === 0) {
    return { complete: true, reason: 'All failing test artifacts resolved (0 failures remaining).' };
  }

  if (focus === 'migrate' && h.legacyCodeTestsPending === 0 && h.legacySkillsAndPrompts === 0) {
    return { complete: true, reason: 'All legacy skills/prompts and Java/C# test items migrated.' };
  }

  if (
    focus === 'baseline' &&
    activeUncovered.length === 0 &&
    h.domainShards > 0 &&
    h.uncompiledTapes === 0 &&
    h.failingTestArtifacts === 0 &&
    h.automatedSpecs > 0
  ) {
    return {
      complete: true,
      reason: `P0 baseline complete across all unblocked shards (${h.automatedSpecs} spec(s), ${session.quarantined.length} quarantined).`,
    };
  }

  if (
    blueprint?.nextAction?.priority === 7 &&
    h.ciConfigured &&
    h.uncompiledTapes === 0 &&
    h.failingTestArtifacts === 0 &&
    activeUncovered.length === 0
  ) {
    const hasExpansionOptions = (blueprint?.nextAction?.gatePayload?.options || []).some(
      (o) => o.id !== 'verify-suite' && !isItemQuarantined(session, o.id)
    );
    if (!hasExpansionOptions || focus !== 'regression') {
      return {
        complete: true,
        reason: `All domain shards covered (${h.domainShards}), tapes compiled, zero drift, and CI configured.`,
      };
    }
  }

  return { complete: false, reason: null };
}

/**
 * Format the compact 4-line live decision update emitted after every cycle while the agent continues working.
 */
export function formatLiveDecisionUpdate(decision, session, blueprint, nowMs = Date.now()) {
  const h = blueprint?.healthSnapshot || {};
  const remainingMs = Math.max(0, (session.nextCheckinAtMs || nowMs) - nowMs);
  return [
    `AUTO-DECISION | cycle:#${decision.cycle} | /${decision.skill} | action:${decision.action} | outcome:${decision.outcome}`,
    `CHOSEN        | ${decision.chosenLabel || decision.chosenOptionId}${decision.command ? ` -> ${decision.command}` : ''}`,
    `RATIONALE     | ${decision.rationale}`,
    `PROGRESS      | specs:${h.automatedSpecs || 0} | tapes:${h.recordedTapes || 0} (uncompiled:${h.uncompiledTapes || 0}) | uncovered:${h.uncoveredShards || 0} | fails:${h.failingTestArtifacts || 0} | quarantined:${session.quarantined.length} | next check-in in ${formatDurationHuman(remainingMs)}`,
  ].join('\n');
}

/**
 * Format the structured Progress & Decision Digest emitted at check-in intervals, blockers, or completion.
 */
export function formatCheckinDigest(session, blueprint, { trigger = 'checkin-interval', message = '', nowMs = Date.now() } = {}) {
  const h = blueprint?.healthSnapshot || {};
  const base = session.baselineSnapshot || {};
  const elapsed = formatDurationHuman(Math.max(0, nowMs - (session.startedAtMs || nowMs)));
  const recentDecisions = session.decisions.slice(session.lastCheckinDecisionIndex || 0);

  const deltaSpecs = (h.automatedSpecs || 0) - (base.automatedSpecs || 0);
  const deltaTapes = (h.recordedTapes || 0) - (base.recordedTapes || 0);
  const sign = (n) => (n > 0 ? `+${n}` : `${n}`);

  const titleMap = {
    'checkin-interval': `⏸️ Autonomous QE Check-In #${session.checkinCount} (${session.schedule.intervalLabel} interval reached)`,
    'completed': `✅ Autonomous QE Objective Complete`,
    'blocker': `🚧 Autonomous QE Hard Blocker — Human Input Required`,
    'max-runtime': `⏱️ Autonomous QE Runtime Cap Reached`,
    'max-cycles': `🔁 Autonomous QE Cycle Cap Reached`,
    'stopped': `🛑 Autonomous QE Session Stopped`,
    'status': `📊 Autonomous QE Status Digest`,
  };

  const lines = [
    `### ${titleMap[trigger] || '📊 Autonomous QE Digest'}`,
    `- **Session:** \`${session.sessionId}\` | **Status:** \`${session.status}\` | **Elapsed:** \`${elapsed}\` | **Cycles:** ${session.cycleCount}`,
    `- **Objective:** ${session.objectives.goal} (\`focus: ${session.objectives.focus}\`, check-in every \`${session.schedule.intervalLabel}\`)`,
    message ? `- **Notice:** ${message}` : null,
    `- **Progress:** ${h.automatedSpecs || 0} specs (${sign(deltaSpecs)}), ${h.recordedTapes || 0} tapes (${sign(deltaTapes)}, ${h.uncompiledTapes || 0} uncompiled), ${h.domainShards || 0} shards (${h.uncoveredShards || 0} uncovered), ${h.failingTestArtifacts || 0} failures, CI ${h.ciConfigured ? 'ok' : 'missing'}`,
    ``,
    `#### Decisions Since Last Check-In (${recentDecisions.length})`,
  ].filter((l) => l !== null);

  if (recentDecisions.length === 0) {
    lines.push(`- *(No decisions recorded since last check-in)*`);
  } else {
    for (const d of recentDecisions.slice(-10)) {
      lines.push(`- **#${d.cycle} \`/${d.skill}\` (${d.outcome}):** ${d.chosenLabel || d.command} — *${d.rationale}*`);
    }
    if (recentDecisions.length > 10) {
      lines.push(`- *(+${recentDecisions.length - 10} earlier decisions — see \`${AUTONOMOUS_LEDGER_REL_PATH}\`)*`);
    }
  }

  if (session.quarantined.length > 0) {
    lines.push(``, `#### ⚠️ Quarantined Items & Logged Defects (${session.quarantined.length})`);
    for (const q of session.quarantined) {
      lines.push(`- \`${q.key}\` (\`${q.category}\`): ${q.reason}${q.defectFile ? ` — \`${q.defectFile}\`` : ''}`);
    }
  }

  lines.push(
    ``,
    `#### Next Actions`,
    `- **Continue:** \`npx cortex orchestrate --autonomous resume\` (optional: \`--interval 2h --goal "<updated>"\`)`,
    `- **Stop:** \`npx cortex orchestrate --autonomous stop\``,
    `- **Full Ledger:** \`${AUTONOMOUS_LEDGER_REL_PATH}\``
  );

  return lines.join('\n');
}
