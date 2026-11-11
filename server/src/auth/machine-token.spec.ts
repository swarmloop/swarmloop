import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { machineToken, tokenMatches } from './machine-token';

describe('machineToken', () => {
  const roots: string[] = [];
  const root = () => roots[roots.push(mkdtempSync(join(tmpdir(), 'swarmloop-token-'))) - 1];
  afterAll(() => roots.forEach((path) => rmSync(path, { recursive: true, force: true })));

  it('uses SWARMLOOP_TOKEN when set', () => {
    expect(machineToken(root(), 'from-env')).toBe('from-env');
  });

  it('generates data/token once with mode 0600 and then reads it back', () => {
    const dir = root();
    const first = machineToken(dir, '');
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(dir, 'data', 'token'), 'utf8').trim()).toBe(first);
    expect(statSync(join(dir, 'data', 'token')).mode & 0o777).toBe(0o600);
    expect(machineToken(dir, undefined)).toBe(first);
  });

  it('compares tokens of any length without throwing', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abc', 'abd')).toBe(false);
    expect(tokenMatches('abc', 'abcd')).toBe(false);
  });
});
