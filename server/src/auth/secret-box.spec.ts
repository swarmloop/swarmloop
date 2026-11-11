import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SecretBox, secretKey } from './secret-box';

describe('SecretBox', () => {
  it('opens what it sealed and does not show the plain text', () => {
    const box = new SecretBox('k');
    const sealed = box.seal('ghu_plain');
    expect(sealed).not.toContain('ghu_plain');
    expect(box.open(sealed)).toBe('ghu_plain');
    expect(box.seal('ghu_plain')).not.toBe(sealed);
  });

  it('refuses a changed value and another key', () => {
    const sealed = new SecretBox('k').seal('value');
    const bytes = Buffer.from(sealed, 'base64');
    bytes[bytes.length - 1] ^= 1;
    expect(() => new SecretBox('k').open(bytes.toString('base64'))).toThrow();
    expect(() => new SecretBox('other').open(sealed)).toThrow();
  });
});

describe('secretKey', () => {
  const roots: string[] = [];
  const root = () => roots[roots.push(mkdtempSync(join(tmpdir(), 'swarmloop-secret-'))) - 1];
  afterAll(() => roots.forEach((path) => rmSync(path, { recursive: true, force: true })));

  it('uses SWARMLOOP_SECRET when set', () => {
    expect(secretKey(root(), 'from-env')).toBe('from-env');
  });

  it('generates data/secret once with mode 0600 and then reads it back', () => {
    const dir = root();
    const first = secretKey(dir, '');
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(dir, 'data', 'secret'), 'utf8').trim()).toBe(first);
    expect(statSync(join(dir, 'data', 'secret')).mode & 0o777).toBe(0o600);
    expect(secretKey(dir, '')).toBe(first);
  });
});
