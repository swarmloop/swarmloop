import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { git, repoTemplate } from '../testing/git-fixture';
import { changeFiles } from './change-files';

const AUTHOR = ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev'];

const mainTemplate = repoTemplate(({ clone }) => {
  writeFileSync(join(clone, 'README'), 'base\n');
  git(clone, ['add', '-A']);
  git(clone, [...AUTHOR, 'commit', '-m', 'base']);
});

function featureRepo(prefix: string): string {
  const repo = mainTemplate(mkdtempSync(join(tmpdir(), prefix)), 'app').clone;
  git(repo, ['checkout', '-b', 'feature/field']);
  return repo;
}

function mountOf(hostPath: string): { hostPath: string; containerPath: string; readonly: boolean } {
  return { hostPath, containerPath: '/work/app', readonly: true };
}

describe('changeFiles', () => {
  it('lists committed, uncommitted and untracked files against the base', async () => {
    const repo = featureRepo('swarmloop-change-files-');
    writeFileSync(join(repo, 'committed.ts'), 'a\n');
    git(repo, ['add', '-A']);
    git(repo, [...AUTHOR, 'commit', '-m', 'committed']);
    writeFileSync(join(repo, 'README'), 'changed\n');
    writeFileSync(join(repo, 'fresh.ts'), 'b\n');

    const files = await changeFiles(mountOf(repo), null);

    expect([...(files ?? [])].sort()).toEqual(['README', 'committed.ts', 'fresh.ts']);
  });

  it('leaves denied paths out', async () => {
    const repo = featureRepo('swarmloop-change-files-denied-');
    mkdirSync(join(repo, 'secrets'));
    writeFileSync(join(repo, 'secrets', 'key.txt'), 'x\n');
    writeFileSync(join(repo, 'kept.ts'), 'a\n');
    git(repo, ['add', 'kept.ts']);
    git(repo, [...AUTHOR, 'commit', '-m', 'kept']);

    expect(await changeFiles(mountOf(repo), null, ['secrets'])).toEqual(['kept.ts']);
  });

  it('is empty for a branch with no change', async () => {
    expect(await changeFiles(mountOf(featureRepo('swarmloop-change-files-none-')), null)).toEqual([]);
  });

  it('is null for a directory that is not a checkout', async () => {
    expect(await changeFiles(mountOf(mkdtempSync(join(tmpdir(), 'swarmloop-change-files-plain-'))), null)).toBeNull();
  });

  it('is null for a checkout with no base', async () => {
    const repo = featureRepo('swarmloop-change-files-nobase-');

    expect(await changeFiles(mountOf(repo), 'task\nbranch: no-such-branch\n')).toBeNull();
  });
});
