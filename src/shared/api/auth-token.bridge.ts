import fs from 'node:fs';
import path from 'node:path';

export interface StorageStateCookie {
  readonly name: string;
  readonly value: string;
  readonly domain?: string;
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

/**
 * Bridges `.auth/<persona>.json` Playwright browser storageState files into HTTP headers
 * for Backend `APIRequestContext` clients (e.g. Back-Office Agent / Underwriting / Claims APIs).
 */
export class AuthTokenBridge {
  static resolveStorageState(storageStatePath: string): StorageStateFile | null {
    const resolved = path.resolve(process.cwd(), storageStatePath);
    if (!fs.existsSync(resolved)) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(resolved, 'utf8')) as StorageStateFile;
    } catch {
      return null;
    }
  }

  /**
   * Extracts a Bearer token from localStorage or cookies in `.auth/<persona>.json`,
   * falling back to an optional environment variable token.
   */
  static extractAuthHeaders(
    storageStatePath: string,
    options?: {
      readonly tokenKeyPattern?: RegExp;
      readonly cookieNames?: readonly string[];
    }
  ): Record<string, string> {
    const state = AuthTokenBridge.resolveStorageState(storageStatePath);
    if (!state) {
      return {};
    }

    const headers: Record<string, string> = {};
    const keyRegex = options?.tokenKeyPattern ?? /(?:access_token|id_token|jwt|auth_token|bearer)/i;

    for (const originEntry of state.origins ?? []) {
      for (const item of originEntry.localStorage ?? []) {
        if (keyRegex.test(item.name) && item.value) {
          const cleanToken = item.value.replace(/^"|"$/g, '');
          headers['Authorization'] = cleanToken.startsWith('Bearer ')
            ? cleanToken
            : `Bearer ${cleanToken}`;
          break;
        }
      }
      if (headers['Authorization']) break;
    }

    const cookies = state.cookies ?? [];
    const filteredCookies = options?.cookieNames?.length
      ? cookies.filter((c) => options.cookieNames?.includes(c.name))
      : cookies;

    if (filteredCookies.length > 0) {
      headers['Cookie'] = filteredCookies.map((c) => `${c.name}=${c.value}`).join('; ');
    }

    return headers;
  }
}
