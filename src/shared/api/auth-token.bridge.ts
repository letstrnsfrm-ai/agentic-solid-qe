import fs from 'node:fs';
import path from 'node:path';

export interface StorageStateCookie {
  readonly name: string;
  readonly value: string;
  readonly domain?: string;
  readonly expires?: number;
  readonly secure?: boolean;
}

export interface StorageStateOriginItem {
  readonly name: string;
  readonly value: string;
}

export interface StorageStateFile {
  readonly cookies?: StorageStateCookie[];
  readonly origins?: Array<{
    readonly origin: string;
    readonly localStorage?: StorageStateOriginItem[];
  }>;
}

const SAFE_STORAGE_STATE_PATH_REGEX = /^\.auth\/[a-zA-Z0-9_-]+\.json$/;
const MAX_STORAGE_STATE_BYTES = 1024 * 1024; // 1 MB cap
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_REGEX = /[\r\n\x00-\x1f\x7f]/g;
const SAFE_COOKIE_NAME_REGEX = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function sanitizeHeaderValue(raw: string): string {
  return raw.replace(CONTROL_CHAR_REGEX, '').trim();
}

function matchesCookieDomain(cookieDomain: string | undefined, targetHost: string | undefined): boolean {
  if (!targetHost || !cookieDomain) return true;
  const normalizedTarget = targetHost.toLowerCase();
  const normalizedCookie = cookieDomain.toLowerCase().replace(/^\.+/, '');
  return (
    normalizedTarget === normalizedCookie ||
    normalizedTarget.endsWith(`.${normalizedCookie}`)
  );
}

/**
 * Bridges `.auth/<persona>.json` Playwright browser storageState files into HTTP headers
 * for Backend `APIRequestContext` clients (e.g. Back-Office Agent / Underwriting / Claims APIs).
 */
export class AuthTokenBridge {
  /**
   * Validates and resolves a `.auth/<persona>.json` path strictly inside the workspace `.auth/` directory,
   * rejecting path traversal (`..`), symbolic links, and oversized files.
   */
  static assertSafeStorageStatePath(storageStatePath: string): string | null {
    const normalizedInput = String(storageStatePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (!SAFE_STORAGE_STATE_PATH_REGEX.test(normalizedInput)) {
      return null;
    }
    const authRoot = path.resolve(process.cwd(), '.auth');
    const resolved = path.resolve(process.cwd(), normalizedInput);
    const relToAuth = path.relative(authRoot, resolved);
    if (relToAuth.startsWith('..') || path.isAbsolute(relToAuth)) {
      return null;
    }
    return resolved;
  }

  static resolveStorageState(storageStatePath: string): StorageStateFile | null {
    const resolved = AuthTokenBridge.assertSafeStorageStatePath(storageStatePath);
    if (!resolved || !fs.existsSync(resolved)) {
      return null;
    }
    try {
      const stat = fs.lstatSync(resolved);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_STORAGE_STATE_BYTES) {
        return null;
      }
      return JSON.parse(fs.readFileSync(resolved, 'utf8')) as StorageStateFile;
    } catch {
      return null;
    }
  }

  /**
   * Enforces owner-only directory (`0o700`) and file (`0o600`) permissions on `.auth/<persona>.json`.
   */
  static hardenStorageStatePermissions(storageStatePath: string): void {
    const resolved = AuthTokenBridge.assertSafeStorageStatePath(storageStatePath);
    if (!resolved) {
      throw new Error(
        `Invalid storageStatePath '${storageStatePath}'. Must match '.auth/<persona>.json' inside the workspace.`
      );
    }
    const dir = path.dirname(resolved);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
      if (fs.existsSync(resolved) && !fs.lstatSync(resolved).isSymbolicLink()) {
        fs.chmodSync(resolved, 0o600);
      }
    } catch {
      /* ignore chmod no-op on non-POSIX filesystems */
    }
  }

  /**
   * Extracts a Bearer token from localStorage or cookies in `.auth/<persona>.json`,
   * scoping to `targetOrigin` (or the primary origin) and filtering out expired/cross-domain cookies.
   */
  static extractAuthHeaders(
    storageStatePath: string,
    options?: {
      readonly tokenKeyPattern?: RegExp;
      readonly cookieNames?: readonly string[];
      readonly targetOrigin?: string;
      readonly allowCrossOrigin?: boolean;
    }
  ): Record<string, string> {
    const state = AuthTokenBridge.resolveStorageState(storageStatePath);
    if (!state) {
      return {};
    }

    let targetOriginUrl: URL | null = null;
    const candidateOrigin = options?.targetOrigin || state.origins?.[0]?.origin;
    if (candidateOrigin) {
      try {
        targetOriginUrl = new URL(candidateOrigin);
      } catch {
        targetOriginUrl = null;
      }
    }

    const headers: Record<string, string> = {};
    const keyRegex = options?.tokenKeyPattern ?? /(?:access_token|id_token|jwt|auth_token|bearer)/i;

    for (const originEntry of state.origins ?? []) {
      if (
        !options?.allowCrossOrigin &&
        targetOriginUrl &&
        originEntry.origin &&
        originEntry.origin !== targetOriginUrl.origin
      ) {
        continue;
      }
      for (const item of originEntry.localStorage ?? []) {
        if (keyRegex.test(item.name) && item.value) {
          const cleanToken = sanitizeHeaderValue(item.value.replace(/^"|"$/g, ''));
          if (cleanToken) {
            headers['Authorization'] = cleanToken.startsWith('Bearer ')
              ? cleanToken
              : `Bearer ${cleanToken}`;
            break;
          }
        }
      }
      if (headers['Authorization']) break;
    }

    const nowSeconds = Date.now() / 1000;
    const cookies = state.cookies ?? [];
    const filteredCookies = cookies.filter((c) => {
      if (!c || !SAFE_COOKIE_NAME_REGEX.test(c.name)) return false;
      if (typeof c.expires === 'number' && c.expires > 0 && c.expires < nowSeconds) {
        return false;
      }
      if (options?.cookieNames?.length && !options.cookieNames.includes(c.name)) {
        return false;
      }
      if (!options?.allowCrossOrigin && targetOriginUrl) {
        if (c.secure && targetOriginUrl.protocol === 'http:' && targetOriginUrl.hostname !== 'localhost') {
          return false;
        }
        if (!matchesCookieDomain(c.domain, targetOriginUrl.hostname)) {
          return false;
        }
      }
      return true;
    });

    if (filteredCookies.length > 0) {
      const serialized = filteredCookies
        .map((c) => `${c.name}=${sanitizeHeaderValue(String(c.value ?? ''))}`)
        .filter((pair) => !pair.endsWith('='))
        .join('; ');
      if (serialized) {
        headers['Cookie'] = serialized;
      }
    }

    return headers;
  }
}

