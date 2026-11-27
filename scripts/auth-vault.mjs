#!/usr/bin/env node
/**
 * Encrypted VPC Auth Vault CLI (`npx cortex auth push|pull|status`).
 *
 * Zero-API-key, zero-dependency AES-256-GCM envelope encryption for Playwright
 * `storageState` files (`.auth/<persona>.json`) with strict TTL enforcement.
 * Cookies and session tokens stay strictly inside the customer VPC vault —
 * Cortex Cloud never receives raw auth state.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const SAFE_PERSONA_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const DEFAULT_TTL_SECONDS = 8 * 60 * 60; // 8 hours

export function assertSafePersonaId(persona) {
  const trimmed = String(persona || '').trim();
  if (!trimmed || !SAFE_PERSONA_RE.test(trimmed) || trimmed.includes('..')) {
    throw new Error(`Invalid persona ID '${persona}'. Use only alphanumeric, dot, underscore, or hyphen.`);
  }
  return trimmed;
}

export function parseTtlSeconds(ttlSpec) {
  if (ttlSpec === undefined || ttlSpec === null || ttlSpec === '') return DEFAULT_TTL_SECONDS;
  let seconds;
  if (typeof ttlSpec === 'number' && Number.isFinite(ttlSpec)) {
    seconds = Math.trunc(ttlSpec);
  } else {
    const str = String(ttlSpec).trim().toLowerCase();
    const match = /^(\d+)(s|m|h|d)?$/.exec(str);
    if (!match) {
      throw new Error(`Invalid TTL '${ttlSpec}'. Examples: 30m, 8h, 1d, 3600s.`);
    }
    const value = Number(match[1]);
    const unit = match[2] || 's';
    const mult = unit === 'd' ? 86400 : unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
    seconds = value * mult;
  }
  if (seconds < 60 || seconds > 7 * 86400) {
    throw new Error(`TTL must be between 60s and 7d (got ${seconds}s).`);
  }
  return seconds;
}

export function deriveVaultKey(secretMaterial, salt) {
  const raw = String(secretMaterial || '').trim();
  if (!raw) {
    throw new Error('Missing vault encryption key. Set CORTEX_VAULT_KEY or pass --key-env <VAR>.');
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  const saltBuf = salt ? Buffer.from(salt, 'base64') : Buffer.from('cortex-auth-vault-v1', 'utf8');
  return crypto.scryptSync(raw, saltBuf, 32);
}

export function encryptStorageState(plaintextJson, secretMaterial, options = {}) {
  const personaId = assertSafePersonaId(options.personaId || 'standard');
  const ttlSeconds = parseTtlSeconds(options.ttlSeconds ?? options.ttl);
  const now = options.now instanceof Date ? options.now : new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

  // Validate JSON structure before encrypting so corrupt files are rejected early.
  JSON.parse(plaintextJson);

  const salt = crypto.randomBytes(16).toString('base64');
  const key = deriveVaultKey(secretMaterial, salt);
  const iv = crypto.randomBytes(12);
  const aad = Buffer.from(`cortex-auth-v1:${personaId}:${expiresAt.toISOString()}`, 'utf8');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plaintextJson, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    schemaVersion: '1.0.0',
    alg: 'aes-256-gcm',
    kdf: 'scrypt',
    salt,
    personaId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: encrypted.toString('base64'),
  };
}

export function decryptStorageState(envelope, secretMaterial, options = {}) {
  if (!envelope || envelope.schemaVersion !== '1.0.0' || envelope.alg !== 'aes-256-gcm') {
    throw new Error('Invalid or unsupported encrypted auth envelope.');
  }
  const personaId = assertSafePersonaId(envelope.personaId);
  const now = options.now instanceof Date ? options.now : new Date();
  const expiresAt = new Date(envelope.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
    throw new Error(`Auth state for persona '${personaId}' expired at ${envelope.expiresAt}. Run 'npx cortex auth push --persona ${personaId}' to refresh.`);
  }

  const key = deriveVaultKey(secretMaterial, envelope.salt || null);
  const iv = Buffer.from(envelope.iv, 'base64');
  const authTag = Buffer.from(envelope.authTag, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  const aad = Buffer.from(`cortex-auth-v1:${personaId}:${envelope.expiresAt}`, 'utf8');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);

  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Failed to decrypt auth envelope: invalid key or tampered ciphertext.');
  }

  return {
    personaId,
    expiresAt: envelope.expiresAt,
    plaintext,
  };
}

function resolveVaultTarget(vaultUri, personaId, cwd) {
  const safePersona = assertSafePersonaId(personaId);
  const uri = String(vaultUri || process.env.CORTEX_AUTH_VAULT || 'file://.cortex-vault').trim();
  if (uri.startsWith('aws-sm://')) {
    const prefix = uri.slice('aws-sm://'.length).replace(/\/+$/, '');
    if (!prefix || prefix.includes('..')) {
      throw new Error(`Invalid aws-sm vault URI: ${uri}`);
    }
    return { backend: 'aws-sm', secretId: `${prefix}/${safePersona}` };
  }
  const rawDir = uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
  const dirPath = path.isAbsolute(rawDir) ? rawDir : path.resolve(cwd, rawDir);
  return {
    backend: 'file',
    dirPath,
    filePath: path.join(dirPath, `${safePersona}.auth.enc.json`),
  };
}

export function writeEnvelopeToVault(envelope, { vaultUri, cwd = process.cwd() } = {}) {
  const target = resolveVaultTarget(vaultUri, envelope.personaId, cwd);
  const serialized = JSON.stringify(envelope, null, 2);

  if (target.backend === 'aws-sm') {
    const put = spawnSync(
      'aws',
      ['secretsmanager', 'put-secret-value', '--secret-id', target.secretId, '--secret-string', serialized],
      { encoding: 'utf8' }
    );
    if (put.status === 0) return { backend: 'aws-sm', location: target.secretId };
    const create = spawnSync(
      'aws',
      ['secretsmanager', 'create-secret', '--name', target.secretId, '--secret-string', serialized],
      { encoding: 'utf8' }
    );
    if (create.status !== 0) {
      throw new Error(`AWS Secrets Manager push failed: ${create.stderr || put.stderr || 'aws CLI unavailable'}`);
    }
    return { backend: 'aws-sm', location: target.secretId };
  }

  fs.mkdirSync(target.dirPath, { recursive: true, mode: 0o700 });
  fs.writeFileSync(target.filePath, serialized, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(target.filePath, 0o600);
  } catch {
    /* non-posix fs */
  }
  return { backend: 'file', location: target.filePath };
}

export function readEnvelopeFromVault(personaId, { vaultUri, cwd = process.cwd() } = {}) {
  const target = resolveVaultTarget(vaultUri, personaId, cwd);
  if (target.backend === 'aws-sm') {
    const res = spawnSync(
      'aws',
      ['secretsmanager', 'get-secret-value', '--secret-id', target.secretId, '--query', 'SecretString', '--output', 'text'],
      { encoding: 'utf8' }
    );
    if (res.status !== 0 || !res.stdout) {
      throw new Error(`AWS Secrets Manager pull failed for '${target.secretId}': ${res.stderr || 'not found'}`);
    }
    return JSON.parse(res.stdout.trim());
  }

  if (!fs.existsSync(target.filePath)) {
    throw new Error(`No vaulted auth state found for persona '${personaId}' at ${target.filePath}`);
  }
  return JSON.parse(fs.readFileSync(target.filePath, 'utf8'));
}

export function pushAuthState({ personaId, inputPath, vaultUri, ttl, secretMaterial, cwd = process.cwd() }) {
  const safePersona = assertSafePersonaId(personaId);
  const resolvedInput = path.resolve(cwd, inputPath || path.join('.auth', `${safePersona}.json`));
  if (!fs.existsSync(resolvedInput)) {
    throw new Error(`Input storageState file not found: ${resolvedInput}`);
  }
  const plaintext = fs.readFileSync(resolvedInput, 'utf8');
  const envelope = encryptStorageState(plaintext, secretMaterial, { personaId: safePersona, ttl });
  const written = writeEnvelopeToVault(envelope, { vaultUri, cwd });
  return {
    personaId: safePersona,
    expiresAt: envelope.expiresAt,
    backend: written.backend,
    location: written.location,
  };
}

export function pullAuthState({ personaId, outputPath, vaultUri, secretMaterial, cwd = process.cwd(), now }) {
  const safePersona = assertSafePersonaId(personaId);
  const envelope = readEnvelopeFromVault(safePersona, { vaultUri, cwd });
  const decrypted = decryptStorageState(envelope, secretMaterial, { now });
  const resolvedOut = path.resolve(cwd, outputPath || path.join('.auth', `${safePersona}.json`));
  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true, mode: 0o700 });
  fs.writeFileSync(resolvedOut, decrypted.plaintext, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(resolvedOut, 0o600);
  } catch {
    /* non-posix fs */
  }
  return {
    personaId: safePersona,
    expiresAt: decrypted.expiresAt,
    outputPath: resolvedOut,
  };
}

function parseCliArgs(argv) {
  const sub = argv[0] || 'help';
  const opts = { persona: 'standard', ttl: '8h', keyEnv: 'CORTEX_VAULT_KEY', json: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--persona' && argv[i + 1]) opts.persona = argv[++i];
    else if (a.startsWith('--persona=')) opts.persona = a.slice('--persona='.length);
    else if (a === '--input' && argv[i + 1]) opts.input = argv[++i];
    else if (a.startsWith('--input=')) opts.input = a.slice('--input='.length);
    else if (a === '--output' && argv[i + 1]) opts.output = argv[++i];
    else if (a.startsWith('--output=')) opts.output = a.slice('--output='.length);
    else if (a === '--vault' && argv[i + 1]) opts.vault = argv[++i];
    else if (a.startsWith('--vault=')) opts.vault = a.slice('--vault='.length);
    else if (a === '--ttl' && argv[i + 1]) opts.ttl = argv[++i];
    else if (a.startsWith('--ttl=')) opts.ttl = a.slice('--ttl='.length);
    else if (a === '--key-env' && argv[i + 1]) opts.keyEnv = argv[++i];
    else if (a.startsWith('--key-env=')) opts.keyEnv = a.slice('--key-env='.length);
    else if (a === '--json') opts.json = true;
  }
  return { sub, opts };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const { sub, opts } = parseCliArgs(process.argv.slice(2));
  try {
    if (sub === 'help' || sub === '--help' || sub === '-h') {
      console.log(`Usage:
  cortex auth push   --persona <id> [--input .auth/<id>.json] [--vault file://.cortex-vault|aws-sm://prefix] [--ttl 8h] [--key-env CORTEX_VAULT_KEY]
  cortex auth pull   --persona <id> [--output .auth/<id>.json] [--vault file://.cortex-vault|aws-sm://prefix] [--key-env CORTEX_VAULT_KEY]
  cortex auth status --persona <id> [--vault file://.cortex-vault|aws-sm://prefix]`);
      process.exit(0);
    }

    const secret = process.env[opts.keyEnv] || '';
    if (sub === 'push') {
      const res = pushAuthState({
        personaId: opts.persona,
        inputPath: opts.input,
        vaultUri: opts.vault,
        ttl: opts.ttl,
        secretMaterial: secret,
      });
      console.log(opts.json ? JSON.stringify(res, null, 2) : `✅ Encrypted auth state pushed for '${res.personaId}' (expires ${res.expiresAt}) -> ${res.location}`);
    } else if (sub === 'pull') {
      const res = pullAuthState({
        personaId: opts.persona,
        outputPath: opts.output,
        vaultUri: opts.vault,
        secretMaterial: secret,
      });
      console.log(opts.json ? JSON.stringify(res, null, 2) : `✅ Auth state restored for '${res.personaId}' (expires ${res.expiresAt}) -> ${res.outputPath}`);
    } else if (sub === 'status') {
      const env = readEnvelopeFromVault(opts.persona, { vaultUri: opts.vault });
      const remainingSec = Math.floor((new Date(env.expiresAt).getTime() - Date.now()) / 1000);
      const status = {
        personaId: env.personaId,
        createdAt: env.createdAt,
        expiresAt: env.expiresAt,
        expired: remainingSec <= 0,
        remainingSeconds: Math.max(0, remainingSec),
      };
      console.log(opts.json ? JSON.stringify(status, null, 2) : `🔐 ${status.personaId}: ${status.expired ? 'EXPIRED' : `valid (${status.remainingSeconds}s left)`} (expires ${status.expiresAt})`);
    } else {
      throw new Error(`Unknown auth subcommand '${sub}'. Use push, pull, or status.`);
    }
  } catch (err) {
    console.error(`❌ cortex auth ${sub} failed: ${err.message}`);
    process.exit(1);
  }
}
