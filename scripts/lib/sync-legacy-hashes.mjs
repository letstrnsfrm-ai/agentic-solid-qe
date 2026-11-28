/**
 * Historical SHA-256 hashes of unmodified framework-owned runtime helpers under `src/shared/`.
 *
 * Prior to v0.50.1, `src/shared/*` helpers were seeded with `overwrite: false` and not recorded in
 * `.agents/framework-manifest.json`. Recognizing their unmodified historical hashes lets
 * `cortex upgrade` / `sync-skills.mjs` safely apply security & runtime fixes in place for adopters
 * upgrading from older releases while still preserving any locally customized copies as patches.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

export const KNOWN_UNMODIFIED_LEGACY_HASHES = Object.freeze({
  'src/shared/api/auth-token.bridge.ts': new Set([
    '1d7b45fde905d2425c0344eb1437c1729551285033282c2a0a8b62ba58766425', // v0.48.18 / v0.50.0
    'ee89026b32450d1b39e9b630e259981d60aa911f5af3378dc295018faad468f3', // v0.48.17
    'b11d490ce7b7a39fdee1a097def2261dd3b3d5e9ea158a0019dd81c4c9021bcb', // v0.48.11
    '077044d23891fbd20e1ab49e14048b468eec0109b17b429a1aa6b9139c2aebb6', // v0.48.9
    '8f43caeb743c10e31eee35a9d330c1d9363c84730784802d08363ab36c2500dc', // security hardening
    'd02d3113896deadcbfde54e4aa3438b3f873fd31c2329aefa5bc02711595b2fd', // security hardening
    'ad2a922f7c3114c45999e6c849c91a0a88de2053f0f65aa808269390f9011680', // initial
  ]),
  'src/shared/data/relative-date.helper.ts': new Set([
    'b56232a208cc0f54df38607aaa034cb692cd8c9afb026b1a2d8e34ea2682f7bf',
    '33448c472822000606ccb8b3d296ca6cd876d9fa3c208c571234b57716ea475e',
  ]),
  'src/shared/ui/explore-handshake.ts': new Set([
    '41a72347e3b4d7e38650d0655be69e57bb0e951ec458d6ee2b78a5155a90d570',
    '8cc744e3781bb55aab77b009f8c5c8fbfafe9de67796f1885ed41df8973a62e4',
    'b29e723d06894f7b5f170f08b663906eb32ca915a4f9fa76371b0ae28c76bc3b',
    '174839033c57c115c34415b1ee61a82ecdcc765727a8c3cdd3b31cb4e06678ff',
    'f7414ca4a84bcb8480965b4e0b8d907556795553d33c4c293e65f9ccdeac72d7',
    '3684c1a9b415f39b8b9748475b6ccdf6be9a600edd06839e3b1e9a15093878ba',
    'f65b30c0b6c8312df993f9c6153ef0bc499daaec2749be96542ba5cb0de4cc6f',
  ]),
  'src/shared/ui/overlay-handler.ts': new Set([
    'd8412fcfa15ba9134ccca727d7637d333b419c89499d0dbe722c140ac5d06f5a',
    'f6571cb763be5a7ae6aee2758c901a89f92f3921bb6d99873571f9c2820228c2',
  ]),
});

/**
 * Returns true if `filePath` matches a known unmodified historical framework version of `relPath`
 * (checking both raw bytes and CRLF-to-LF normalized text for cross-platform checkouts).
 */
export function isKnownUnmodifiedLegacyFile(relPath, filePath, destHash) {
  const known = KNOWN_UNMODIFIED_LEGACY_HASHES[relPath];
  if (!known) return false;
  if (known.has(destHash)) return true;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (raw.includes('\r\n')) {
      const lfHash = crypto.createHash('sha256').update(raw.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
      return known.has(lfHash);
    }
  } catch {
    /* ignore unreadable file */
  }
  return false;
}
