import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import * as delays from '../core/delay';
import { clearGitFaults, distrustGit, failGit } from '../testing/git-fault.spec-helpers';
import { git } from '../testing/git-fixture';
import { captureTree, ownsRepo, requireTree } from './worktree-tree';

import type * as GitFault from '../testing/git-fault.spec-helpers';

jest.mock('child_process', () =>
  jest.requireActual<typeof GitFault>('../testing/git-fault.spec-helpers').faultyChildProcess(),
);

const DUBIOUS = "fatal: detected dubious ownership in repository at '/work/x'";

/** The tree git makes with an empty index: every file is hashed again. */
function emptyIndexTree(repo: string): string {
  // Called after captureTree; this drops the repository's index before rebuilding it.
  rmSync(join(repo, '.git', 'index'), { force: true });
  git(repo, ['add', '-A']);
  return git(repo, ['write-tree']);
}

function bigRepo(files: number): string {
  const repo = mkdtempSync(join(tmpdir(), 'swarmloop-big-'));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'dev@example.com']);
  git(repo, ['config', 'user.name', 'Dev']);
  // A detached `gc --auto` after the commit would still write into .git while the test removes it.
  git(repo, ['config', 'gc.auto', '0']);
  for (let directory = 0; directory < files / 100; directory += 1) {
    mkdirSync(join(repo, `d${directory}`));
    for (let file = 0; file < 100; file += 1) {
      writeFileSync(join(repo, `d${directory}`, `f${file}.txt`), `${directory}-${file}\n`);
    }
  }
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base']);
  return repo;
}

describe('captureTree', () => {
  it('gives the tree of an empty index, with 20 000 tracked files and one changed', async () => {
    const repo = bigRepo(20_000);
    writeFileSync(join(repo, 'd0', 'f0.txt'), 'changed\n');
    writeFileSync(join(repo, 'untracked.txt'), 'new\n');

    const captured = await captureTree(repo);

    expect(captured?.tree).toBe(emptyIndexTree(repo));
    expect(captured?.head).toBe(git(repo, ['rev-parse', 'HEAD']));
    rmSync(repo, { recursive: true, force: true });
  }, 120_000);

  it('hashes only the files that changed: a file git still sees as unchanged keeps its stored content', async () => {
    const repo = bigRepo(200);
    const file = join(repo, 'd1', 'f1.txt');
    // Rewriting the file moves its ctime, and git compares ctime by the second: when the clock ticks over between
    // the refresh and the rewrite, git reads the file again. Only mtime and size say "unchanged" here.
    git(repo, ['config', 'core.trustctime', 'false']);
    // An mtime older than the index, so git does not treat the file as racily clean.
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(file, past, past);
    git(repo, ['update-index', '-q', '--refresh']);
    const before = statSync(file);
    // Same size and mtime, other bytes. Git trusts the stat of its own index, so it does not read this file again.
    writeFileSync(file, `${'x'.repeat(before.size - 1)}\n`);
    utimesSync(file, before.atime, before.mtime);
    writeFileSync(join(repo, 'd0', 'f0.txt'), 'changed\n');

    const captured = await captureTree(repo);

    const stored = git(repo, ['rev-parse', 'HEAD:d1/f1.txt']);
    expect(git(repo, ['rev-parse', `${captured?.tree}:d1/f1.txt`])).toBe(stored);
    expect(git(repo, ['cat-file', '-p', `${captured?.tree}:d0/f0.txt`])).toBe('changed');
    rmSync(repo, { recursive: true, force: true });
  });

  it('leaves the index and HEAD of the repository alone', async () => {
    const repo = bigRepo(100);
    writeFileSync(join(repo, 'new.txt'), 'new\n');
    const status = git(repo, ['status', '--porcelain']);
    const head = git(repo, ['rev-parse', 'HEAD']);

    await captureTree(repo);

    expect(git(repo, ['status', '--porcelain'])).toBe(status);
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(head);
    rmSync(repo, { recursive: true, force: true });
  });

  it('works in a repository with no index file yet', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'swarmloop-fresh-'));
    git(repo, ['init', '-q']);
    writeFileSync(join(repo, 'a.txt'), 'a\n');

    const captured = await captureTree(repo);

    expect(captured?.tree).toBe(emptyIndexTree(repo));
    rmSync(repo, { recursive: true, force: true });
  });
});

describe('the git probe', () => {
  let waits: number[];

  beforeEach(() => {
    waits = [];
    jest.spyOn(delays, 'delay').mockImplementation(async (ms) => {
      waits.push(ms);
    });
  });

  afterEach(() => {
    clearGitFaults();
    jest.restoreAllMocks();
  });

  function plainRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), 'swarmloop-probe-'));
    git(repo, ['init', '-q']);
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    return repo;
  }

  describe('under the checkout roots', () => {
    let root: string;
    let saved: string | undefined;

    beforeEach(() => {
      saved = process.env.SWARMLOOP_ROOT;
      root = realpathSync(mkdtempSync(join(tmpdir(), 'swarmloop-root-')));
      process.env.SWARMLOOP_ROOT = root;
    });

    afterEach(() => {
      if (saved === undefined) {
        delete process.env.SWARMLOOP_ROOT;
      } else {
        process.env.SWARMLOOP_ROOT = saved;
      }
      rmSync(root, { recursive: true, force: true });
    });

    function repoAt(path: string): string {
      mkdirSync(path, { recursive: true });
      git(path, ['init', '-q']);
      git(path, ['config', 'user.email', 'dev@example.com']);
      git(path, ['config', 'user.name', 'Dev']);
      writeFileSync(join(path, 'a.txt'), 'a\n');
      git(path, ['add', '-A']);
      git(path, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base']);
      return path;
    }

    it('trusts a worktree whose owner is not the process user', async () => {
      const repo = repoAt(join(root, 'worktrees', 'PROJ-1', 'app'));
      distrustGit(join(root, 'worktrees'));

      expect(await ownsRepo(repo)).toBe(true);
      expect((await captureTree(repo))?.head).toBe(git(repo, ['rev-parse', 'HEAD']));
    });

    it('does not trust a repository outside the roots', async () => {
      const repo = repoAt(join(root, 'elsewhere', 'app'));
      distrustGit(join(root, 'elsewhere'));

      await expect(captureTree(repo)).rejects.toThrow('dubious ownership');
    });
  });

  it("fails with git's text when the probe fails on both tries", async () => {
    const repo = plainRepo();
    failGit(['rev-parse', '--show-toplevel'], { stderr: DUBIOUS }, 2);

    await expect(captureTree(repo)).rejects.toThrow('dubious ownership');
    rmSync(repo, { recursive: true, force: true });
  });

  it('tries a failed probe once more after a second', async () => {
    const repo = plainRepo();
    failGit(['rev-parse', '--show-toplevel'], { stderr: DUBIOUS });

    const captured = await captureTree(repo);

    expect(captured?.tree).toBe(emptyIndexTree(repo));
    expect(waits).toEqual([1000]);
    rmSync(repo, { recursive: true, force: true });
  });

  it('answers false and null when git says the path is not in a repository', async () => {
    const repo = plainRepo();
    failGit(['rev-parse', '--is-inside-work-tree'], {
      stderr: 'fatal: not a git repository (or any of the parent directories): .git',
    });

    expect(await ownsRepo(repo)).toBe(false);
    failGit(['rev-parse', '--is-inside-work-tree'], { stderr: 'fatal: not a git repository' });
    expect(await captureTree(repo)).toBeNull();
    expect(waits).toEqual([]);
    rmSync(repo, { recursive: true, force: true });
  });

  it('answers false and null when git prints false for the work tree check', async () => {
    const repo = plainRepo();
    failGit(['rev-parse', '--is-inside-work-tree'], { stdout: 'false\n' }, 2);

    expect(await ownsRepo(repo)).toBe(false);
    expect(await captureTree(repo)).toBeNull();
    rmSync(repo, { recursive: true, force: true });
  });

  it('answers false and null for a path that does not exist, with no git call', async () => {
    failGit(['rev-parse'], { stderr: DUBIOUS }, 5);
    const missing = join(tmpdir(), 'swarmloop-probe-missing');

    expect(await ownsRepo(missing)).toBe(false);
    expect(await captureTree(missing)).toBeNull();
  });

  it('answers false and null for a subdirectory of a repository', async () => {
    const repo = plainRepo();
    mkdirSync(join(repo, 'sub'));

    expect(await ownsRepo(join(repo, 'sub'))).toBe(false);
    expect(await captureTree(join(repo, 'sub'))).toBeNull();
    rmSync(repo, { recursive: true, force: true });
  });

  it('requireTree fails with the name and the path for a folder that is not a repository', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'swarmloop-plain-'));
    failGit(['rev-parse', '--is-inside-work-tree'], { stderr: 'fatal: not a git repository' });

    await expect(requireTree(folder)).rejects.toThrow(`${basename(folder)}: no git tree at ${folder}`);
    rmSync(folder, { recursive: true, force: true });
  });
});
