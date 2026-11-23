import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppConfig } from '../../config/env';
import { worktreePath } from '../../git/repo-names';
import { root } from '../../history/run-paths';
import { testEnv } from '../../config/env.spec-helpers';
import { copyMainWithOrigin, git } from '../../testing/git-fixture';
import { MainHeld } from './main-held';

describe('main held', () => {
  let base: string;
  let held: MainHeld;
  let worktree: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'swarmloop-main-held-'));
    const config = new AppConfig(testEnv({ SWARMLOOP_ROOT: base }));
    held = new MainHeld(config);
    worktree = worktreePath(root(config), 'f1', 'demo');
    copyMainWithOrigin(join(base, 'src'), 'demo');
    git(base, ['clone', '-q', join(base, 'src', 'demo'), worktree]);
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('holds a commit its history has and not a newer one it lacks', async () => {
    const head = git(worktree, ['rev-parse', 'HEAD']);
    expect(await held.holds('f1', 'demo', head)).toBe(true);
    const source = join(base, 'src', 'demo');
    git(source, ['config', 'user.email', 'dev@example.com']);
    git(source, ['config', 'user.name', 'Dev']);
    git(source, ['commit', '--allow-empty', '-m', 'newer']);
    expect(await held.holds('f1', 'demo', git(source, ['rev-parse', 'HEAD']))).toBe(false);
  });

  it('does not hold a commit when the run has no worktree', async () => {
    expect(await held.holds('f2', 'demo', git(worktree, ['rev-parse', 'HEAD']))).toBe(false);
  });
});
