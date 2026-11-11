import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const SKIP = new Set(['node_modules', '.next']);
/** Paths of the GitHub and GitLab APIs. The dashboard talks only to the swarmloop API. */
const HOST_API = /\/user\/repos|\/user\/orgs|\/api\/v4|api\.github\.com\/|gitlab\.com\/api/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (SKIP.has(name)) {
      return [];
    }
    return statSync(path).isDirectory() ? sources(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('dashboard sources', () => {
  it('name no GitHub or GitLab API path', () => {
    const offenders = sources(ROOT).filter(
      (path) => !path.endsWith('no-host-api-paths.test.ts') && HOST_API.test(readFileSync(path, 'utf8')),
    );

    expect(offenders).toEqual([]);
  });
});
