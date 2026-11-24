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

function decodeHexIpv4Mapped(bare: string): string | null {
  const m = bare.match(/^(?:0*:)*ffff:(?:0+:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!m) return null;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}

function isForbiddenTargetUrl(parsed: URL): boolean {
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
  if (parsed.username || parsed.password) return true;
  const hostLower = parsed.hostname.toLowerCase();
  const bare = hostLower.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  const isLocal = bare === 'localhost' || bare === '127.0.0.1' || bare === '::1';
  if (isLocal) return false;
  const mappedV4 = decodeHexIpv4Mapped(bare);
  const checkHost = mappedV4 || bare;
  if (
    FORBIDDEN_METADATA_HOSTS.has(hostLower) ||
    FORBIDDEN_METADATA_HOSTS.has(bare) ||
    FORBIDDEN_METADATA_HOSTS.has(checkHost) ||
    /^169\.254\./.test(checkHost) ||
    /^127\./.test(checkHost) ||
    /^0\./.test(checkHost) ||
    /^(?:22[4-9]|2[34]\d|25[0-5])\./.test(checkHost) ||
    bare === '::' ||
    bare === '0:0:0:0:0:0:0:0' ||
    bare === '0:0:0:0:0:0:0:1' ||
    /^64:ff9b:/i.test(bare) ||
    /^fe[89ab][0-9a-f]:/i.test(bare) ||
    /^ff[0-9a-f]{2}:/i.test(bare) ||
    /^fd00:ec2::/i.test(bare) ||
    /^(?:0*:)*ffff:0:/i.test(bare) ||
    /^::[0-9a-f]{1,4}:[0-9a-f]{1,4}$/i.test(bare)
  ) {
    return true;
  }
  const allowPrivate =
    process.env.CORTEX_ALLOW_PRIVATE_NET === '1' || process.env.CORTEX_ALLOW_PRIVATE_NET === 'true';
  if (!allowPrivate) {
    if (
      /^10\./.test(checkHost) ||
      /^192\.168\./.test(checkHost) ||
      /^172\.(?:1[6-9]|2\d|3[01])\./.test(checkHost) ||
      /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(checkHost) ||
      /^f[cd][0-9a-f]{2}:/i.test(bare)
    ) {
      return true;
    }
  }
  return false;
}

function sanitizeHeaderValue(raw: string): string {
  return raw.replace(CONTROL_CHAR_REGEX, '').trim();
}

function matchesCookieDomain(
  cookieDomain: string | undefined,
  targetHost: string | undefined,
  fallbackOriginHost?: string
): boolean {
  if (!targetHost) return true;
  const effectiveDomain = cookieDomain || fallbackOriginHost;
  if (!effectiveDomain) return false;
  const normalizedTarget = targetHost.toLowerCase();
  const normalizedCookie = effectiveDomain.toLowerCase().replace(/^\.+/, '');
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
   * rejecting path traversal (`..`), symbolic links (file or parent `.auth/` dir), and oversized files.
   */
  static assertSafeStorageStatePath(storageStatePath: string): string | null {
    const normalizedInput = String(storageStatePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (!SAFE_STORAGE_STATE_PATH_REGEX.test(normalizedInput)) {
      return null;
    }
    const workspaceRoot = path.resolve(process.cwd());
    const authRoot = path.resolve(workspaceRoot, '.auth');
    const resolved = path.resolve(workspaceRoot, normalizedInput);
    const relToAuth = path.relative(authRoot, resolved);
    if (relToAuth.startsWith('..') || path.isAbsolute(relToAuth)) {
      return null;
    }
    for (const candidate of [authRoot, resolved]) {
      try {
        if (fs.lstatSync(candidate).isSymbolicLink()) return null;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') return null;
      }
    }
    if (fs.existsSync(workspaceRoot)) {
      try {
        const realRoot = fs.realpathSync(workspaceRoot);
        let existing = resolved;
        while (!fs.existsSync(existing) && existing !== workspaceRoot) {
          const parent = path.dirname(existing);
          if (parent === existing) break;
          existing = parent;
        }
        const realExisting = fs.realpathSync(existing);
        const realRel = path.relative(realRoot, realExisting);
        if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
          return null;
        }
      } catch {
        return null;
      }
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

    let primaryOriginHost: string | undefined;
    if (state.origins?.[0]?.origin) {
      try {
        primaryOriginHost = new URL(state.origins[0].origin).hostname;
      } catch {
        primaryOriginHost = undefined;
      }
    }

    let targetOriginUrl: URL | null = null;
    const candidateOrigin = options?.targetOrigin ?? state.origins?.[0]?.origin;
    if (candidateOrigin !== undefined) {
      try {
        targetOriginUrl = new URL(candidateOrigin);
        if (isForbiddenTargetUrl(targetOriginUrl)) {
          return {};
        }
      } catch {
        if (options?.targetOrigin !== undefined) {
          return {};
        }
        targetOriginUrl = null;
      }
    }

    const headers: Record<string, string> = {};
    const rawKeyRegex = options?.tokenKeyPattern ?? /(?:access_token|id_token|jwt|auth_token|bearer)/i;
    const keyRegex = /[gy]/.test(rawKeyRegex.flags)
      ? new RegExp(rawKeyRegex.source, rawKeyRegex.flags.replace(/[gy]/g, ''))
      : rawKeyRegex;

    for (const originEntry of state.origins ?? []) {
      if (
        !options?.allowCrossOrigin &&
        targetOriginUrl &&
        (!originEntry.origin || originEntry.origin !== targetOriginUrl.origin)
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
        if (!matchesCookieDomain(c.domain, targetOriginUrl.hostname, primaryOriginHost)) {
          return false;
        }
      }
      return true;
    });

    if (filteredCookies.length > 0) {
      const serialized = filteredCookies
        .map((c) => [c.name, sanitizeHeaderValue(String(c.value ?? '')).replace(/;/g, '')] as const)
        .filter(([, val]) => val.length > 0)
        .map(([name, val]) => `${name}=${val}`)
        .join('; ');
      if (serialized) {
        headers['Cookie'] = serialized;
      }
    }

    return headers;
  }
}

