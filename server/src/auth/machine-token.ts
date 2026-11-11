import { randomBytes, timingSafeEqual } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/** The machine token: `SWARMLOOP_TOKEN` when set, else the one in `data/token`, made with mode 0600 on first use. */
export function machineToken(root: string, configured: string | undefined): string {
  if (configured) {
    return configured;
  }
  const file = join(root, 'data', 'token');
  if (existsSync(file)) {
    return readFileSync(file, 'utf8').trim();
  }
  const token = randomBytes(32).toString('hex');
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

export function tokenMatches(expected: string, given: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(given);
  return left.length === right.length && timingSafeEqual(left, right);
}
