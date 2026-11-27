#!/usr/bin/env node
/**
 * Zero-LLM-API-Key VPC Runner Daemon (`npx cortex runner start`).
 *
 * Outbound pull-only worker that connects a customer VPC to Cortex Cloud:
 *   1. Registers runner capabilities (`executorMode: agent-seat | deterministic | vpc-iam-gateway`)
 *   2. Sends heartbeats (renewing active shard leases)
 *   3. Claims Coverage Expansion Work Orders atomically
 *   4. Executes deterministically (`cortex orchestrate --loop --json` + `verify:fast`)
 *      or delegates open-ended exploration to a zero-API-key enterprise coding-agent seat
 *   5. Parks cleanly on `GATE_OPTIONS` into Cortex Cloud's Async Gate Inbox
 *   6. Reports completion/PR links back to Cortex Cloud
 *
 * Zero LLM SDKs. Zero static LLM API keys.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pullAuthState } from './auth-vault.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const VALID_EXECUTOR_MODES = new Set(['agent-seat', 'deterministic', 'vpc-iam-gateway']);

export function createCloudClient({ cloudUrl, token, fetchImpl = fetch }) {
  const baseUrl = String(cloudUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    throw new Error('Missing or invalid --cloud-url (or CORTEX_CLOUD_URL). Must start with http:// or https://.');
  }
  const authToken = String(token || '').trim();
  if (!authToken) {
    throw new Error('Missing runner token. Set CORTEX_CLOUD_TOKEN or pass --token.');
  }

  async function requestJson(method, endpoint, body) {
    const res = await fetchImpl(`${baseUrl}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'cortex-runner/1.0',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }
    if (!res.ok) {
      const msg = parsed?.error || `HTTP ${res.status}`;
      throw new Error(`Cortex Cloud ${method} ${endpoint} failed (${res.status}): ${msg}`);
    }
    return parsed;
  }

  return {
    register: (payload) => requestJson('POST', '/api/v1/runners/register', payload),
    heartbeat: (payload) => requestJson('POST', '/api/v1/runners/heartbeat', payload),
    claim: (payload) => requestJson('POST', '/api/v1/runners/claim', payload),
    postEvent: (workOrderId, payload) =>
      requestJson('POST', `/api/v1/work-orders/${encodeURIComponent(String(workOrderId))}/events`, payload),
    postGate: (workOrderId, payload) =>
      requestJson('POST', `/api/v1/work-orders/${encodeURIComponent(String(workOrderId))}/gates`, payload),
  };
}

/**
 * Splits a CLI command string honoring single and double quotes without invoking a shell.
 */
export function parseCommandLine(cmd) {
  const str = String(cmd || '').trim();
  if (!str) return [];
  const args = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < str.length) {
        current += str[++i];
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (quote) {
    throw new Error(`Unterminated ${quote} quote in --agent-cmd.`);
  }
  if (current.length > 0) args.push(current);
  return args;
}

export function extractGatePayloadFromBlueprint(result) {
  const gp = result?.nextAction?.gatePayload || result?.finalBlueprint?.nextAction?.gatePayload;
  if (!gp || !Array.isArray(gp.options) || gp.options.length === 0) return null;
  return {
    gateId: String(gp.gateId || result?.nextAction?.skill || 'human-gate').slice(0, 128),
    summary: String(
      gp.summary ||
        gp.question ||
        result?.nextAction?.humanGate ||
        'Human direction required to proceed with Coverage Expansion Work Order.'
    ).slice(0, 4000),
    options: gp.options.slice(0, 20).map((opt, idx) => ({
      index: idx + 1,
      label: String(opt.label || `Option ${idx + 1}`).slice(0, 200),
      command: String(opt.command || 'npx cortex orchestrate').slice(0, 500),
      ...(idx === 0 || opt.recommended ? { recommended: true } : {}),
    })),
  };
}

export function buildExecutorPrompt(workOrder) {
  const p = workOrder.payload || {};
  const lines = [
    `Read AGENTS.md and invoke /agentic-solid-qe.`,
    `Work Order ID: ${workOrder.id}`,
    `Target Deployed App URL (black-box only): ${p.deployedUrl || ''}`,
    `Squad: ${workOrder.squad || 'default'} | Route Shard: ${workOrder.shardKey || p.routeShard || ''}`,
    `Goal: ${p.goal || ''}`,
  ];
  if (p.personaId) {
    lines.push(`Persona: ${p.personaId} (pre-restored to .auth/${p.personaId}.json)`);
  }
  if (workOrder.lastGateResolution) {
    const r = workOrder.lastGateResolution;
    lines.push(
      `Resolved Human Gate (${r.gateId}): Option #${r.selectedOptionIndex} — ${r.label} -> ${r.command}${
        r.humanNote ? ` (Note: ${r.humanNote})` : ''
      }`
    );
  }
  lines.push(
    `Run 'npx cortex orchestrate --loop --compact' and 'npx cortex verify --fast'. Do not weaken assertions.`
  );
  return lines.join('\n');
}

export function defaultRunCortexOrchestrate({ cwd, squad, resumeGate, choice }) {
  const orchScript = path.join(__dirname, 'orchestrate.mjs');
  const args = [orchScript, '--loop', '--json'];
  if (squad && squad !== 'default') args.push('--squad', squad);
  if (resumeGate && choice) {
    args.push('--resume-gate', String(resumeGate), '--choice', String(choice));
  }
  const res = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  let parsed = null;
  try {
    const out = (res.stdout || '').trim();
    const jsonStart = out.indexOf('{');
    if (jsonStart >= 0) parsed = JSON.parse(out.slice(jsonStart));
  } catch {
    parsed = null;
  }
  return {
    exitCode: res.status ?? 1,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    parsed,
  };
}

export async function executeWorkOrder({
  workOrder,
  runnerId,
  executorMode,
  agentCmd,
  vaultUri,
  cwd = process.cwd(),
  cloudClient,
  heartbeatIntervalMs = 60_000,
  runOrchestrate = defaultRunCortexOrchestrate,
  runAgentSeat = null,
}) {
  const payload = workOrder.payload || {};

  // Restore TTL-scoped encrypted persona auth state strictly inside VPC if configured.
  if (payload.personaId && process.env.CORTEX_VAULT_KEY) {
    try {
      pullAuthState({
        personaId: payload.personaId,
        vaultUri,
        secretMaterial: process.env.CORTEX_VAULT_KEY,
        cwd,
      });
    } catch (err) {
      await cloudClient.postGate(workOrder.id, {
        runnerId,
        gateId: 'auth-expired',
        summary: `Persona '${payload.personaId}' auth state missing or expired: ${err.message}`,
        options: [
          {
            index: 1,
            label: `Refresh '${payload.personaId}' auth via npx cortex auth push and retry`,
            command: `npx cortex auth push --persona ${payload.personaId} --ttl 8h`,
            recommended: true,
          },
          {
            index: 2,
            label: 'Cancel work order',
            command: 'cancel',
          },
        ],
        branchName: workOrder.branchName || undefined,
      });
      return { outcome: 'waiting_gate', gateId: 'auth-expired' };
    }
  }

  await cloudClient.postEvent(workOrder.id, {
    runnerId,
    status: 'running',
    branchName: workOrder.branchName || undefined,
  });

  // Keep shard lease alive during long-running executions (>5 min).
  let heartbeatTimer = null;
  if (typeof cloudClient.heartbeat === 'function' && Number.isFinite(heartbeatIntervalMs) && heartbeatIntervalMs > 0) {
    heartbeatTimer = setInterval(() => {
      void cloudClient.heartbeat({ runnerId, status: 'busy', activeJobs: 1 }).catch(() => {});
    }, heartbeatIntervalMs);
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
  }

  try {
    // Delegate reasoning to zero-API-key enterprise agent seat or VPC Workload-IAM gateway when configured.
    const usesExternalExecutor = executorMode === 'agent-seat' || executorMode === 'vpc-iam-gateway';
    if (usesExternalExecutor && (runAgentSeat || agentCmd)) {
      const prompt = buildExecutorPrompt(workOrder);
      if (runAgentSeat) {
        await runAgentSeat({ prompt, workOrder, cwd, executorMode });
      } else if (agentCmd) {
        const parts = parseCommandLine(agentCmd);
        if (parts.length === 0) {
          throw new Error('Empty --agent-cmd.');
        }
        const res = spawnSync(parts[0], [...parts.slice(1), prompt], {
          cwd,
          encoding: 'utf8',
          stdio: 'pipe',
          shell: false,
        });
        if (res.status !== 0) {
          await cloudClient.postEvent(workOrder.id, {
            runnerId,
            status: 'failed',
            error: `Executor command exited with code ${res.status}: ${(res.stderr || res.stdout || '').slice(0, 1000)}`,
          });
          return { outcome: 'failed' };
        }
      }
    }

    // Run deterministic Cortex orchestrator loop (with --resume-gate if resuming from Async Gate Inbox).
    const resume = workOrder.lastGateResolution || null;
    const orchResult = await runOrchestrate({
      cwd,
      squad: workOrder.squad,
      resumeGate: resume?.gateId,
      choice: resume?.selectedOptionIndex,
      workOrder,
    });

    const gatePayload = extractGatePayloadFromBlueprint(orchResult.parsed);
    if (gatePayload) {
      await cloudClient.postGate(workOrder.id, {
        runnerId,
        ...gatePayload,
        branchName: workOrder.branchName || undefined,
      });
      return { outcome: 'waiting_gate', gateId: gatePayload.gateId };
    }

    // Never mark a work order completed if orchestrate only resolved a gate without executing the loop.
    if (orchResult.parsed?.executed === false) {
      await cloudClient.postEvent(workOrder.id, {
        runnerId,
        status: 'failed',
        error: 'Orchestrator returned resume-only output (executed: false) without running the loop.',
      });
      return { outcome: 'failed' };
    }

    if (orchResult.exitCode !== 0) {
      await cloudClient.postEvent(workOrder.id, {
        runnerId,
        status: 'failed',
        error: (orchResult.stderr || orchResult.stdout || 'cortex orchestrate failed').slice(0, 1500),
      });
      return { outcome: 'failed' };
    }

    const tokenUsed = Number(orchResult.parsed?.tokenUsed || 0);
    if (workOrder.tokenBudget && tokenUsed > workOrder.tokenBudget) {
      await cloudClient.postEvent(workOrder.id, {
        runnerId,
        status: 'failed',
        branchName: workOrder.branchName || undefined,
        tokenUsed,
        error: `Token footprint budget exceeded (${tokenUsed} > ${workOrder.tokenBudget} tok).`,
      });
      return { outcome: 'budget_exceeded', tokenUsed };
    }

    await cloudClient.postEvent(workOrder.id, {
      runnerId,
      status: 'completed',
      branchName: workOrder.branchName || undefined,
      tokenUsed,
    });
    return { outcome: 'completed', tokenUsed };
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
}

/**
 * Deterministic pre-PR conflict avoidance for parallel shard branches:
 * rebases onto baseBranch and regenerates `.agents/domain/domain-graph.json`.
 */
export function rebaseAndRefreshGraph({ cwd, baseBranch = 'origin/main' }) {
  const rebase = spawnSync('git', ['rebase', baseBranch], { cwd, encoding: 'utf8' });
  if (rebase.status !== 0) {
    spawnSync('git', ['rebase', '--abort'], { cwd, encoding: 'utf8' });
    return { ok: false, step: 'rebase', error: (rebase.stderr || rebase.stdout || 'git rebase failed').trim() };
  }
  const graph = spawnSync(process.execPath, [path.join(__dirname, 'build-domain-graph.mjs')], {
    cwd,
    encoding: 'utf8',
  });
  if (graph.status !== 0) {
    return { ok: false, step: 'graph', error: (graph.stderr || graph.stdout || 'cortex graph failed').trim() };
  }
  return { ok: true };
}

export async function runSinglePollCycle({
  cloudClient,
  runnerId,
  executorMode = 'deterministic',
  agentCmd = '',
  vaultUri,
  cwd = process.cwd(),
  heartbeatIntervalMs = 60_000,
  runOrchestrate,
  runAgentSeat,
}) {
  const claimed = await cloudClient.claim({ runnerId, leaseTtlSeconds: 300 });
  if (!claimed?.workOrder) {
    return { claimed: false, outcome: 'idle' };
  }
  const execRes = await executeWorkOrder({
    workOrder: claimed.workOrder,
    runnerId,
    executorMode,
    agentCmd,
    vaultUri,
    cwd,
    cloudClient,
    heartbeatIntervalMs,
    runOrchestrate,
    runAgentSeat,
  });
  return { claimed: true, workOrderId: claimed.workOrder.id, ...execRes };
}

export function normalizePollMs(value, fallback = 5000) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 1000) return fallback;
  return Math.trunc(num);
}

function parseRunnerArgs(argv) {
  const sub = argv[0] || 'help';
  const opts = {
    cloudUrl: process.env.CORTEX_CLOUD_URL || '',
    token: process.env.CORTEX_CLOUD_TOKEN || '',
    name: process.env.CORTEX_RUNNER_NAME || `${os.hostname()}-cortex-runner`,
    labels: (process.env.CORTEX_RUNNER_LABELS || '').split(',').map((s) => s.trim()).filter(Boolean),
    executor: process.env.CORTEX_EXECUTOR_MODE || 'agent-seat',
    agentCmd: process.env.CORTEX_AGENT_CMD || '',
    vault: process.env.CORTEX_AUTH_VAULT || 'file://.cortex-vault',
    pollMs: normalizePollMs(process.env.CORTEX_RUNNER_POLL_MS, 5000),
    once: false,
  };

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cloud-url' && argv[i + 1]) opts.cloudUrl = argv[++i];
    else if (a.startsWith('--cloud-url=')) opts.cloudUrl = a.slice('--cloud-url='.length);
    else if (a === '--token' && argv[i + 1]) opts.token = argv[++i];
    else if (a.startsWith('--token=')) opts.token = a.slice('--token='.length);
    else if (a === '--name' && argv[i + 1]) opts.name = argv[++i];
    else if (a.startsWith('--name=')) opts.name = a.slice('--name='.length);
    else if (a === '--labels' && argv[i + 1]) opts.labels = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--executor' && argv[i + 1]) opts.executor = argv[++i];
    else if (a.startsWith('--executor=')) opts.executor = a.slice('--executor='.length);
    else if (a === '--agent-cmd' && argv[i + 1]) opts.agentCmd = argv[++i];
    else if (a === '--vault' && argv[i + 1]) opts.vault = argv[++i];
    else if (a === '--poll-ms' && argv[i + 1]) opts.pollMs = normalizePollMs(argv[++i], 5000);
    else if (a === '--once') opts.once = true;
  }

  if (!VALID_EXECUTOR_MODES.has(opts.executor)) {
    throw new Error(`Invalid --executor '${opts.executor}'. Use agent-seat, deterministic, or vpc-iam-gateway.`);
  }
  return { sub, opts };
}

function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return pkg.version || '0.49.0';
  } catch {
    return '0.49.0';
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  (async () => {
    const { sub, opts } = parseRunnerArgs(process.argv.slice(2));
    if (sub === 'help' || sub === '--help' || sub === '-h') {
      console.log(`Usage:
  CORTEX_CLOUD_TOKEN=<token> cortex runner start --cloud-url <url> [--executor agent-seat|deterministic|vpc-iam-gateway] [--agent-cmd "<cmd>"] [--labels vpc:staging] [--poll-ms 5000] [--once]

Notes:
  - Prefer CORTEX_CLOUD_TOKEN env var over --token so bearer secrets are not exposed in process argv.
  - Each runner pod executes 1 work order at a time (scale horizontally with K8s replicas).`);
      process.exit(0);
    }
    if (sub !== 'start') {
      throw new Error(`Unknown runner subcommand '${sub}'. Use 'start'.`);
    }

    const cloudClient = createCloudClient({ cloudUrl: opts.cloudUrl, token: opts.token });
    const reg = await cloudClient.register({
      name: opts.name,
      labels: opts.labels,
      executorMode: opts.executor,
      maxConcurrency: 1,
      cliVersion: readPackageVersion(),
    });
    const runnerId = reg.runner.id;
    console.log(`🏭 Cortex VPC Runner online: ${opts.name} (${runnerId}) [executor=${opts.executor}, zero-api-key]`);

    if (opts.once) {
      const cycle = await runSinglePollCycle({
        cloudClient,
        runnerId,
        executorMode: opts.executor,
        agentCmd: opts.agentCmd,
        vaultUri: opts.vault,
      });
      console.log(JSON.stringify(cycle, null, 2));
      process.exit(cycle.outcome === 'failed' || cycle.outcome === 'budget_exceeded' ? 1 : 0);
    }

    let stopping = false;
    process.on('SIGINT', () => { stopping = true; });
    process.on('SIGTERM', () => { stopping = true; });

    while (!stopping) {
      try {
        await cloudClient.heartbeat({ runnerId, status: 'online', activeJobs: 0 });
        const cycle = await runSinglePollCycle({
          cloudClient,
          runnerId,
          executorMode: opts.executor,
          agentCmd: opts.agentCmd,
          vaultUri: opts.vault,
        });
        if (cycle.claimed) {
          console.log(`⚙️  Work order ${cycle.workOrderId} -> ${cycle.outcome}`);
        }
      } catch (err) {
        console.error(`⚠️  Runner poll error: ${err.message}`);
      }
      if (!stopping) {
        await new Promise((r) => setTimeout(r, opts.pollMs));
      }
    }
  })().catch((err) => {
    console.error(`❌ cortex runner failed: ${err.message}`);
    process.exit(1);
  });
}
