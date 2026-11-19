import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';

export interface ExploreCheckpoint {
  schemaVersion: '1.0.0';
  capturedAt: string;
  url: string;
  cookies: Parameters<BrowserContext['addCookies']>[0];
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  variables: Record<string, string>;
  actor?: string;
  scenarioId?: string;
  resumeStep?: string;
}

export interface ExploreHoldOptions {
  checkpointName?: string;
  pausedAtStep?: string;
  variables?: Record<string, string>;
  actor?: string;
  scenarioId?: string;
}

const CHECKPOINTS_DIR = path.resolve(process.cwd(), '.exploratory', 'checkpoints');
const LIVE_SESSION_FILE = path.resolve(process.cwd(), '.exploratory', 'live-session.json');
const RELEASE_SENTINEL_FILE = path.resolve(process.cwd(), '.exploratory', 'live-session.release');

function resolveSafeCheckpointPath(nameOrRelPath: string): string {
  const isRelPath = nameOrRelPath.startsWith('.exploratory/checkpoints/');
  const target = isRelPath
    ? path.resolve(process.cwd(), nameOrRelPath)
    : path.resolve(CHECKPOINTS_DIR, `${nameOrRelPath.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}.json`);
  const rel = path.relative(CHECKPOINTS_DIR, target);
  if (rel.startsWith('..') || path.isAbsolute(rel) || !target.endsWith('.json')) {
    throw new Error(`Unsafe checkpoint path outside .exploratory/checkpoints/: ${nameOrRelPath}`);
  }
  return target;
}

function writePrivateJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* non-POSIX filesystem */
  }
}

/**
 * Captures full browser state (cookies, localStorage, sessionStorage, URL, variables)
 * into a gitignored `.exploratory/checkpoints/<name>.json` file for <1s reuse.
 */
export async function captureCheckpoint(
  page: Page,
  context: BrowserContext,
  options: ExploreHoldOptions = {}
): Promise<{ checkpointPath: string; checkpoint: ExploreCheckpoint }> {
  const name = options.checkpointName || process.env.PW_EXPLORE_CHECKPOINT || 'live-point-a';
  const checkpointPath = resolveSafeCheckpointPath(name);
  const url = page.url();
  const cookies = await context.cookies();

  let storage: { local: Record<string, string>; session: Record<string, string> } = {
    local: {},
    session: {},
  };
  try {
    storage = await page.evaluate(() => {
      const readStore = (s: Storage): Record<string, string> => {
        const out: Record<string, string> = {};
        for (let i = 0; i < s.length; i++) {
          const k = s.key(i);
          if (k !== null) out[k] = s.getItem(k) ?? '';
        }
        return out;
      };
      return { local: readStore(window.localStorage), session: readStore(window.sessionStorage) };
    });
  } catch {
    /* about:blank or cross-origin frame */
  }

  const checkpoint: ExploreCheckpoint = {
    schemaVersion: '1.0.0',
    capturedAt: new Date().toISOString(),
    url,
    cookies,
    localStorage: storage.local,
    sessionStorage: storage.session,
    variables: options.variables || {},
    ...(options.actor ? { actor: options.actor } : {}),
    ...(options.scenarioId ? { scenarioId: options.scenarioId } : {}),
    ...(options.pausedAtStep ? { resumeStep: options.pausedAtStep } : {}),
  };

  writePrivateJson(checkpointPath, checkpoint);
  return { checkpointPath, checkpoint };
}

/**
 * Restores a saved ExploreCheckpoint (cookies, origin-scoped localStorage/sessionStorage, URL)
 * and returns its captured variables for downstream Point-B -> Point-C execution.
 */
export async function restoreCheckpoint(
  context: BrowserContext,
  page: Page,
  checkpointRelPath: string
): Promise<Record<string, string>> {
  const checkpointFile = resolveSafeCheckpointPath(checkpointRelPath);
  if (!fs.existsSync(checkpointFile)) {
    throw new Error(
      `Missing Point-A checkpoint state at ${checkpointRelPath}. Run the parent spec or 'npx cortex explore start' first.`
    );
  }
  const checkpoint = JSON.parse(fs.readFileSync(checkpointFile, 'utf8')) as Partial<ExploreCheckpoint>;
  if (Array.isArray(checkpoint.cookies) && checkpoint.cookies.length > 0) {
    await context.addCookies(checkpoint.cookies);
  }

  const targetUrl = typeof checkpoint.url === 'string' && /^https?:\/\//i.test(checkpoint.url) ? checkpoint.url : '';
  const localEntries = checkpoint.localStorage && typeof checkpoint.localStorage === 'object' ? checkpoint.localStorage : {};
  const sessionEntries = checkpoint.sessionStorage && typeof checkpoint.sessionStorage === 'object' ? checkpoint.sessionStorage : {};

  if (targetUrl && (Object.keys(localEntries).length > 0 || Object.keys(sessionEntries).length > 0)) {
    const targetOrigin = new URL(targetUrl).origin;
    await context.addInitScript(
      ({ origin, local, session }: { origin: string; local: Record<string, string>; session: Record<string, string> }) => {
        if (window.location.origin !== origin) return;
        for (const [k, v] of Object.entries(local)) window.localStorage.setItem(k, v);
        for (const [k, v] of Object.entries(session)) window.sessionStorage.setItem(k, v);
      },
      { origin: targetOrigin, local: localEntries, session: sessionEntries }
    );
  }

  if (targetUrl) {
    await page.goto(targetUrl);
  }
  return checkpoint.variables && typeof checkpoint.variables === 'object' ? checkpoint.variables : {};
}

/**
 * Holds a live Playwright browser open for CDP attachment (`agent-browser --cdp <port>`).
 * In handshake mode (`PW_EXPLORE_HANDSHAKE=1`), works headless without Playwright Inspector
 * and exits cleanly once `.exploratory/live-session.release` is written by `cortex explore finish`.
 */
export async function holdForExplore(
  page: Page,
  context: BrowserContext,
  options: ExploreHoldOptions = {}
): Promise<void> {
  if (process.env.CI || process.env.PW_PAUSE_FOR_EXPLORE !== '1') return;

  const { checkpointPath } = await captureCheckpoint(page, context, options);
  const cdpPort = /^\d{4,5}$/.test(process.env.EXPLORE_CDP_PORT || '') ? Number(process.env.EXPLORE_CDP_PORT) : 9222;
  const manifest = {
    pid: process.pid,
    cdpPort,
    cdpUrl: `http://127.0.0.1:${cdpPort}`,
    currentUrl: page.url(),
    checkpointPath: path.relative(process.cwd(), checkpointPath).replace(/\\/g, '/'),
    pausedAtStep: options.pausedAtStep || null,
    variables: options.variables || {},
    readyAt: new Date().toISOString(),
  };

  if (fs.existsSync(RELEASE_SENTINEL_FILE)) {
    try {
      fs.unlinkSync(RELEASE_SENTINEL_FILE);
    } catch {
      /* ignore */
    }
  }
  writePrivateJson(LIVE_SESSION_FILE, manifest);

  if (process.env.PW_EXPLORE_HANDSHAKE === '1') {
    await new Promise<void>((resolve) => {
      const cleanup = () => {
        clearInterval(timer);
        process.off('SIGINT', cleanup);
        process.off('SIGTERM', cleanup);
        resolve();
      };
      const timer = setInterval(() => {
        if (fs.existsSync(RELEASE_SENTINEL_FILE) || page.isClosed()) {
          cleanup();
        }
      }, 200);
      process.once('SIGINT', cleanup);
      process.once('SIGTERM', cleanup);
    });
    return;
  }

  await page.pause();
}
