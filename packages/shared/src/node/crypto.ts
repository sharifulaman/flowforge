import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV is the GCM recommendation
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

export interface EncryptedPayload {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
}

export class DecryptionError extends Error {
  constructor(message = 'Unable to decrypt payload') {
    super(message);
    this.name = 'DecryptionError';
  }
}

/**
 * AES-256-GCM envelope for credentials at rest.
 *
 * - A fresh random IV per encryption.
 * - Optional AAD (additional authenticated data) binds a ciphertext to its owner
 *   (e.g. `workspaceId:appKey`) so a row's secret cannot be copied into another row.
 * - Multiple key versions support rotation: encrypt with `currentVersion`, decrypt with
 *   whichever version the record was written with.
 */
export class SecretBox {
  private readonly keys: Map<number, Buffer>;

  constructor(
    keys: Record<number, Buffer> | Map<number, Buffer>,
    private readonly currentVersion: number,
  ) {
    this.keys = keys instanceof Map ? new Map(keys) : new Map(Object.entries(keys).map(([k, v]) => [Number(k), v]));
    for (const [version, key] of this.keys) {
      if (key.length !== KEY_LENGTH) {
        throw new Error(`Encryption key v${version} must be ${KEY_LENGTH} bytes, got ${key.length}`);
      }
    }
    if (!this.keys.has(currentVersion)) {
      throw new Error(`No encryption key configured for current version v${currentVersion}`);
    }
  }

  /** Build from env: ENCRYPTION_KEY (+ version) and optional ENCRYPTION_KEYS_PREVIOUS. */
  static fromConfig(cfg: {
    ENCRYPTION_KEY: string;
    ENCRYPTION_KEY_VERSION: number;
    ENCRYPTION_KEYS_PREVIOUS?: string;
  }): SecretBox {
    const keys = new Map<number, Buffer>();
    for (const entry of (cfg.ENCRYPTION_KEYS_PREVIOUS ?? '').split(',').map((s) => s.trim())) {
      if (!entry) continue;
      const idx = entry.indexOf(':');
      if (idx < 1) throw new Error('ENCRYPTION_KEYS_PREVIOUS entries must look like "<version>:<base64>"');
      keys.set(Number(entry.slice(0, idx)), Buffer.from(entry.slice(idx + 1), 'base64'));
    }
    keys.set(cfg.ENCRYPTION_KEY_VERSION, Buffer.from(cfg.ENCRYPTION_KEY, 'base64'));
    return new SecretBox(keys, cfg.ENCRYPTION_KEY_VERSION);
  }

  get version(): number {
    return this.currentVersion;
  }

  encrypt(plaintext: Buffer, aad?: string): EncryptedPayload {
    const key = this.keys.get(this.currentVersion)!;
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
    if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: this.currentVersion };
  }

  decrypt(payload: EncryptedPayload, aad?: string): Buffer {
    const key = this.keys.get(payload.keyVersion);
    if (!key) throw new DecryptionError(`Unknown key version v${payload.keyVersion}`);
    if (payload.iv.length !== IV_LENGTH || payload.authTag.length !== TAG_LENGTH) {
      throw new DecryptionError('Malformed encrypted payload');
    }
    try {
      const decipher = createDecipheriv(ALGORITHM, key, payload.iv, { authTagLength: TAG_LENGTH });
      if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(payload.authTag);
      return Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
    } catch {
      // Never leak OpenSSL details (or partial plaintext).
      throw new DecryptionError();
    }
  }

  encryptJson(value: unknown, aad?: string): EncryptedPayload {
    return this.encrypt(Buffer.from(JSON.stringify(value), 'utf8'), aad);
  }

  decryptJson<T = unknown>(payload: EncryptedPayload, aad?: string): T {
    return JSON.parse(this.decrypt(payload, aad).toString('utf8')) as T;
  }

  /** True when the record should be re-encrypted with the current key. */
  needsRotation(payload: Pick<EncryptedPayload, 'keyVersion'>): boolean {
    return payload.keyVersion !== this.currentVersion;
  }
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** URL-safe random token with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time string comparison (length difference returns false without leaking timing of content). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
