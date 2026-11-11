import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The secret key: `SWARMLOOP_SECRET` when set, else the one in `data/secret`, made with mode 0600 on first use. */
export function secretKey(root: string, configured: string | undefined): string {
  if (configured) {
    return configured;
  }
  const file = join(root, 'data', 'secret');
  if (existsSync(file)) {
    return readFileSync(file, 'utf8').trim();
  }
  const secret = randomBytes(32).toString('hex');
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  return secret;
}

/** AES-256-GCM. A sealed value is base64 of `iv | tag | ciphertext`. */
export class SecretBox {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = createHash('sha256').update(secret).digest();
  }

  seal(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }

  /** Throws when the value was changed or sealed with another key. */
  open(sealed: string): string {
    const bytes = Buffer.from(sealed, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, IV_BYTES));
    decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  }
}
