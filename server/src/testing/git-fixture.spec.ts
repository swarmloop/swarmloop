import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { copyMainWithOrigin, git } from './git-fixture';

const roots: string[] = [];

function copy(): { clone: string; remote: string } {
  const root = mkdtempSync(join(tmpdir(), 'swarmloop-git-fixture-spec-'));
  roots.push(root);
  return copyMainWithOrigin(root, 'demo');
}

function commit(clone: string, file: string): void {
  git(clone, ['switch', '-c', `work-${file}`]);
  git(clone, ['commit', '--allow-empty', '-m', file]);
}

function resolves(cwd: string, ref: string): boolean {
  try {
    git(cwd, ['rev-parse', '--verify', ref]);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('git fixture', () => {
  it('two copies are independent', () => {
    const first = copy();
    const second = copy();
    commit(first.clone, 'one');
    expect(resolves(first.clone, 'work-one')).toBe(true);
    expect(resolves(second.clone, 'work-one')).toBe(false);
    expect(resolves(second.remote, 'work-one')).toBe(false);
  });

  it('a push reaches the copied origin only', () => {
    const first = copy();
    const second = copy();
    commit(first.clone, 'two');
    git(first.clone, ['push', 'origin', 'work-two']);
    expect(resolves(first.remote, 'work-two')).toBe(true);
    expect(resolves(second.remote, 'work-two')).toBe(false);
    expect(resolves(copy().remote, 'work-two')).toBe(false);
  });
});
