import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256-bit random token, URL-safe. Used for sessions, CSRF and one-time links. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time comparison of two strings of possibly different length. */
export function safeEqual(a: string, b: string): boolean {
  const ha = sha256(a);
  const hb = sha256(b);
  return timingSafeEqual(ha, hb);
}

export function hmacHex(key: string, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

/**
 * AES-256-GCM envelope: [1 byte version][12 byte IV][16 byte tag][ciphertext].
 * The AAD binds the ciphertext to its owner and record id, so a ciphertext
 * copied into another user's row fails to decrypt.
 */
export class DataCipher {
  constructor(
    private readonly keys: Map<number, Buffer>,
    private readonly activeKeyId: number,
  ) {}

  get activeKey(): number {
    return this.activeKeyId;
  }

  encrypt(plaintext: string, aad: string): { keyId: number; ciphertext: Buffer } {
    const key = this.keys.get(this.activeKeyId);
    if (!key) throw new Error('active encryption key missing');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { keyId: this.activeKeyId, ciphertext: Buffer.concat([Buffer.from([1]), iv, tag, ct]) };
  }

  decrypt(keyId: number, blob: Buffer, aad: string): string {
    const key = this.keys.get(keyId);
    if (!key) throw new Error(`encryption key ${keyId} unavailable`);
    if (blob.length < 29 || blob[0] !== 1) throw new Error('unsupported ciphertext format');
    const iv = blob.subarray(1, 13);
    const tag = blob.subarray(13, 29);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]).toString('utf8');
  }
}
