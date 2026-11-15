import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { copyMainWithOrigin, git, repoTemplate } from './git-fixture';

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

  it('a template holds the commits it was made with and pushes its branch to the copied origin', () => {
    const fileTemplate = repoTemplate(({ clone, name }) => {
      writeFileSync(join(clone, 'file.txt'), `${name}\n`);
      git(clone, ['add', 'file.txt']);
      git(clone, ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', 'commit', '-m', 'file']);
    });
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-git-fixture-spec-'));
    roots.push(root);

    const { clone, remote } = fileTemplate(root, 'demo', 'trunk');

    expect(git(clone, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('trunk');
    expect(git(clone, ['log', '-1', '--format=%s'])).toBe('file');
    expect(git(remote, ['log', '-1', '--format=%s', 'trunk'])).toBe('file');
    expect(git(clone, ['remote', 'get-url', 'origin'])).toBe(remote);
  });

  it('templates that share a repository name do not share a copy', () => {
    const marked = (mark: string) =>
      repoTemplate(({ clone }) => {
        writeFileSync(join(clone, mark), `${mark}\n`);
        git(clone, ['add', mark]);
        git(clone, ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', 'commit', '-m', mark]);
      });
    const first = mkdtempSync(join(tmpdir(), 'swarmloop-git-fixture-spec-'));
    const second = mkdtempSync(join(tmpdir(), 'swarmloop-git-fixture-spec-'));
    roots.push(first, second);

    const a = marked('a.txt')(first, 'demo').clone;
    const b = marked('b.txt')(second, 'demo').clone;

    expect(existsSync(join(a, 'a.txt'))).toBe(true);
    expect(existsSync(join(a, 'b.txt'))).toBe(false);
    expect(existsSync(join(b, 'b.txt'))).toBe(true);
    expect(existsSync(join(b, 'a.txt'))).toBe(false);
  });
});
