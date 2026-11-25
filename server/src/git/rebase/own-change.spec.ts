import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { git } from '../../testing/git-fixture';
import { hasOwnChange, ownChangeBase } from './own-change';

function commit(dir: string, file: string, message: string): string {
  writeFileSync(join(dir, file), `${message}\n`);
  git(dir, ['add', file]);
  git(dir, ['commit', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

/** `main` with one commit, and an `epic` branch with one commit of its own. */
function repo(): { dir: string; main: string; epic: string } {
  const dir = mkdtempSync(join(tmpdir(), 'swarmloop-own-change-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'dev@example.com']);
  git(dir, ['config', 'user.name', 'Dev']);
  const main = commit(dir, 'base.ts', 'base');
  git(dir, ['switch', '-c', 'epic']);
  const epic = commit(dir, 'epic.ts', 'epic');
  return { dir, main, epic };
}

/** Main moves on and the epic branch is rewritten onto it: the old epic tip is no ancestor of the new one. */
function rewriteEpic(dir: string): string {
  git(dir, ['switch', 'main']);
  commit(dir, 'moved.ts', 'moved');
  git(dir, ['switch', 'epic']);
  git(dir, ['rebase', 'main']);
  return git(dir, ['rev-parse', 'HEAD']);
}

describe('ownChangeBase', () => {
  it('is the merge base git finds for a run on main with no known tips', async () => {
    const { dir, main } = repo();
    git(dir, ['switch', 'main']);
    git(dir, ['switch', '-c', 'work']);
    commit(dir, 'work.ts', 'work');
    git(dir, ['switch', 'main']);
    const moved = commit(dir, 'moved.ts', 'moved');
    git(dir, ['switch', 'work']);

    expect(await ownChangeBase(dir, [], moved)).toBe(main);
  });

  it('is the old epic tip a part stood on after the epic branch was rewritten', async () => {
    const { dir, epic } = repo();
    git(dir, ['switch', '-c', 'part']);
    commit(dir, 'part.ts', 'part');
    const newTip = rewriteEpic(dir);
    git(dir, ['switch', 'part']);

    expect(await ownChangeBase(dir, [epic], newTip)).toBe(epic);
  });

  it('skips a known commit the repository does not have', async () => {
    const { dir, epic } = repo();
    git(dir, ['switch', '-c', 'part']);
    commit(dir, 'part.ts', 'part');

    expect(await ownChangeBase(dir, ['0'.repeat(40)], epic)).toBe(epic);
  });
});

describe('hasOwnChange', () => {
  it('is false for a part whose head is the old epic tip, and true once it commits', async () => {
    const { dir, epic } = repo();
    git(dir, ['switch', '-c', 'part']);

    expect(await hasOwnChange(dir, epic)).toBe(false);

    commit(dir, 'part.ts', 'part');

    expect(await hasOwnChange(dir, epic)).toBe(true);
  });
});
