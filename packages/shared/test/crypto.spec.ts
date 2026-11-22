import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DecryptionError, SecretBox, randomToken, safeEqual, sha256Hex } from '../src/node/crypto';

const k1 = randomBytes(32);
const k2 = randomBytes(32);

describe('SecretBox (AES-256-GCM)', () => {
  it('round-trips JSON', () => {
    const box = new SecretBox({ 1: k1 }, 1);
    const secret = { accessToken: 'xoxb-123', nested: { a: [1, 2, 3] } };
    const enc = box.encryptJson(secret, 'ws_1:slack');
    expect(enc.iv).toHaveLength(12);
    expect(enc.authTag).toHaveLength(16);
    expect(enc.ciphertext.toString('utf8')).not.toContain('xoxb');
    expect(box.decryptJson(enc, 'ws_1:slack')).toEqual(secret);
  });

  it('uses a fresh IV per encryption', () => {
    const box = new SecretBox({ 1: k1 }, 1);
    const a = box.encryptJson('same');
    const b = box.encryptJson('same');
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('rejects tampered ciphertext', () => {
    const box = new SecretBox({ 1: k1 }, 1);
    const enc = box.encryptJson({ x: 1 });
    enc.ciphertext[0] = enc.ciphertext[0]! ^ 0xff;
    expect(() => box.decryptJson(enc)).toThrow(DecryptionError);
  });

  it('rejects a tampered auth tag', () => {
    const box = new SecretBox({ 1: k1 }, 1);
    const enc = box.encryptJson({ x: 1 });
    enc.authTag[0] = enc.authTag[0]! ^ 0x01;
    expect(() => box.decryptJson(enc)).toThrow(DecryptionError);
  });

  it('binds ciphertext to AAD (prevents row swapping)', () => {
    const box = new SecretBox({ 1: k1 }, 1);
    const enc = box.encryptJson({ x: 1 }, 'ws_1:slack');
    expect(() => box.decryptJson(enc, 'ws_2:slack')).toThrow(DecryptionError);
    expect(() => box.decryptJson(enc)).toThrow(DecryptionError);
  });

  it('fails with the wrong key', () => {
    const enc = new SecretBox({ 1: k1 }, 1).encryptJson({ x: 1 });
    expect(() => new SecretBox({ 1: k2 }, 1).decryptJson(enc)).toThrow(DecryptionError);
  });

  it('supports key rotation', () => {
    const old = new SecretBox({ 1: k1 }, 1);
    const enc = old.encryptJson({ legacy: true });
    const rotated = new SecretBox({ 1: k1, 2: k2 }, 2);
    expect(rotated.needsRotation(enc)).toBe(true);
    expect(rotated.decryptJson(enc)).toEqual({ legacy: true });
    const reenc = rotated.encryptJson({ legacy: true });
    expect(reenc.keyVersion).toBe(2);
    expect(rotated.needsRotation(reenc)).toBe(false);
  });

  it('errors on unknown key version', () => {
    const enc = new SecretBox({ 3: k1 }, 3).encryptJson('x');
    expect(() => new SecretBox({ 1: k1 }, 1).decrypt(enc)).toThrow(/Unknown key version/);
  });

  it('validates key length and current version', () => {
    expect(() => new SecretBox({ 1: randomBytes(16) }, 1)).toThrow(/32 bytes/);
    expect(() => new SecretBox({ 1: k1 }, 2)).toThrow(/current version/);
  });

  it('builds from env config including previous keys', () => {
    const box = SecretBox.fromConfig({
      ENCRYPTION_KEY: k2.toString('base64'),
      ENCRYPTION_KEY_VERSION: 2,
      ENCRYPTION_KEYS_PREVIOUS: `1:${k1.toString('base64')}`,
    });
    const legacy = new SecretBox({ 1: k1 }, 1).encryptJson('v1');
    expect(box.decryptJson(legacy)).toBe('v1');
    expect(box.version).toBe(2);
  });
});

describe('token helpers', () => {
  it('randomToken is url-safe with the requested entropy', () => {
    const t = randomToken(32);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(t, 'base64url')).toHaveLength(32);
    expect(randomToken()).not.toBe(randomToken());
  });

  it('sha256Hex is deterministic', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('safeEqual compares correctly', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
