import 'reflect-metadata';

import { existsSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FakeClock } from '../../core/fake-clock.spec-helpers';
import { featureWorktree, git } from '../../testing/runs.spec-helpers';
import { git as gitAsync } from '../git';
import { withWorktree } from '../worktree-lock';
import { rebaseFeatureRepos } from '.';
import { completeRebase, fingerprintOf } from './journal';
import { memoryJournal } from './journal.spec-helpers';
import * as squash from './squash';
import * as workflow from './workflow';

const hosts = { GITLAB_BASE_URL: '', GITLAB_TOKEN: '', GITHUB_BASE_URL: '', GITHUB_TOKEN: '', clock: new FakeClock() };

interface Setup {
  root: string;
  key: string;
  tree: string;
  oldHead: string;
  base: string;
  journal: ReturnType<typeof memoryJournal>;
  rebase: () => ReturnType<typeof rebaseFeatureRepos>;
}

/** A feature worktree with one commit of its own, and a base that moved on origin. */
async function setup(key: string): Promise<Setup> {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-squash-'));
  const { tree, clone } = featureWorktree(root, key);
  writeFileSync(join(tree, 'own.ts'), 'export const own = 1;\n');
  git(tree, ['add', 'own.ts']);
  git(tree, ['commit', '-m', 'own change']);
  const oldHead = git(tree, ['rev-parse', 'HEAD']);
  git(clone, ['switch', 'main']);
  writeFileSync(join(clone, 'moved.ts'), 'export const moved = 1;\n');
  git(clone, ['add', 'moved.ts']);
  git(clone, ['commit', '-m', 'moved']);
  git(clone, ['push', 'origin', 'main']);
  const base = git(clone, ['rev-parse', 'HEAD']);
  const journal = memoryJournal();
  return {
    root,
    key,
    tree,
    oldHead,
    base,
    journal,
    rebase: () =>
      rebaseFeatureRepos({
        root,
        key,
        repos: ['demo'],
        branch: `feature/${key}-ship-the-field`,
        prompt: null,
        denied: [],
        message: `feat(${key}): Ship the field`,
        hosts,
        journal,
      }),
  };
}

/** Calls through to gitAt; after the squash fetch it runs `after` with the clone's commit and tree. */
function afterSquashFetch(after: (made: string, madeTree: string) => void): { made: () => string; tree: () => string } {
  let made = '';
  let tree = '';
  const real = workflow.gitAt;
  jest.spyOn(workflow, 'gitAt').mockImplementation(async (...args) => {
    const result = await real(...args);
    const clone = args[2].find((arg) => arg.includes('swarmloop-rebase-'));
    if (args[2].includes('fetch') && clone) {
      made = git(clone, ['rev-parse', 'HEAD']);
      tree = git(clone, ['rev-parse', 'HEAD^{tree}']);
      after(made, tree);
    }
    return result;
  });
  return { made: () => made, tree: () => tree };
}

describe('squash from the clone', () => {
  let previousRoot: string | undefined;

  beforeEach(() => {
    previousRoot = process.env.SWARMLOOP_ROOT;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (previousRoot === undefined) {
      delete process.env.SWARMLOOP_ROOT;
    } else {
      process.env.SWARMLOOP_ROOT = previousRoot;
    }
  });

  it('moves the worktree to the clone commit and records it in the journal', async () => {
    const run = await setup('proj-f117-a');
    process.env.SWARMLOOP_ROOT = run.root;
    const clone = afterSquashFetch(() => undefined);
    await run.rebase();
    expect(clone.made()).not.toBe('');
    expect(git(run.tree, ['rev-parse', 'HEAD'])).toBe(clone.made());
    expect(git(run.tree, ['rev-parse', 'HEAD^{tree}'])).toBe(clone.tree());
    expect(git(run.tree, ['rev-parse', 'HEAD^'])).toBe(run.base);
    const entry = await run.journal.entry('demo');
    expect(entry).toMatchObject({ checkpoint: 'applied', squashSha: clone.made() });
  });

  it('gives a run on main the tree, parent, message and author of a squash merge of its head', async () => {
    const run = await setup('proj-f117-m');
    process.env.SWARMLOOP_ROOT = run.root;
    const merged = git(run.tree, ['merge-tree', '--write-tree', run.base, run.oldHead]);
    await run.rebase();
    expect(git(run.tree, ['rev-parse', 'HEAD^{tree}'])).toBe(merged);
    expect(git(run.tree, ['rev-parse', 'HEAD^'])).toBe(run.base);
    expect(git(run.tree, ['log', '-1', '--format=%s'])).toBe('feat(proj-f117-m): Ship the field');
    expect(git(run.tree, ['log', '-1', '--format=%an %ae'])).toBe(
      git(run.tree, ['log', '-1', '--format=%an %ae', run.oldHead]),
    );
  });

  it('ignores a fetch of another ref that lands before the reset', async () => {
    const run = await setup('proj-f117-b');
    process.env.SWARMLOOP_ROOT = run.root;
    const clone = afterSquashFetch(() => {
      git(run.tree, ['fetch', 'origin', 'refs/heads/main']);
      expect(git(run.tree, ['rev-parse', 'FETCH_HEAD'])).toBe(run.base);
    });
    await run.rebase();
    expect(git(run.tree, ['rev-parse', 'HEAD'])).toBe(clone.made());
    expect(git(run.tree, ['rev-parse', 'HEAD^{tree}'])).toBe(clone.tree());
    expect(existsSync(join(run.tree, 'own.ts'))).toBe(true);
  });

  it('stops before the reset when the squash ref names another commit', async () => {
    const run = await setup('proj-f117-c');
    process.env.SWARMLOOP_ROOT = run.root;
    const clone = afterSquashFetch(() => {
      git(run.tree, ['update-ref', `refs/swarmloop/squash/${run.key}`, run.base]);
    });
    const failure = await run.rebase().catch((error: unknown) => error);
    expect((failure as Error).message).toBe(
      `demo rebase failed: the squash ${clone.made()} is not what the worktree would move to (${run.base})`,
    );
    expect(git(run.tree, ['rev-parse', 'HEAD'])).toBe(run.oldHead);
    expect(existsSync(join(run.tree, 'own.ts'))).toBe(true);
    const entry = await run.journal.entry('demo');
    expect(entry?.squashSha).toBeUndefined();
  });

  it('keeps the squash ref until the rebase completes', async () => {
    const run = await setup('proj-f117-d');
    process.env.SWARMLOOP_ROOT = run.root;
    const clone = afterSquashFetch(() => undefined);
    await run.rebase();
    const ref = `refs/swarmloop/squash/${run.key}`;
    expect(git(run.tree, ['rev-parse', ref])).toBe(clone.made());
    await completeRebase(run.journal, run.key);
    expect(git(run.tree, ['for-each-ref', ref])).toBe('');
  });

  it('starts no git in the worktree while another operation holds the worktree', async () => {
    const run = await setup('proj-f117-e');
    process.env.SWARMLOOP_ROOT = run.root;
    const real = squash.publishedTip;
    let reached = (): void => undefined;
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    jest.spyOn(squash, 'publishedTip').mockImplementation(async (...args) => {
      const tip = await real(...args);
      reached();
      return tip;
    });
    const gitCalls = jest.spyOn(workflow, 'gitAt');
    let gitStartedWhileHeld = -1;
    const held = withWorktree(run.tree, async () => {
      await arrived;
      for (let step = 0; step < 6; step += 1) {
        await gitAsync(['-C', run.tree, 'rev-parse', 'HEAD']);
      }
      gitStartedWhileHeld = gitCalls.mock.calls.length;
    });
    await Promise.all([held, run.rebase()]);
    expect(gitStartedWhileHeld).toBe(0);
    expect((await run.journal.entry('demo'))?.oldHead).toBe(run.oldHead);
  });
});

describe('a move after the base branch was rewritten', () => {
  let previousRoot: string | undefined;

  beforeEach(() => {
    previousRoot = process.env.SWARMLOOP_ROOT;
  });

  afterEach(() => {
    if (previousRoot === undefined) {
      delete process.env.SWARMLOOP_ROOT;
    } else {
      process.env.SWARMLOOP_ROOT = previousRoot;
    }
  });

  /** A part standing on the old tip of an epic branch, which origin then got again on a moved main with another `epic.ts`. */
  async function rewritten(key: string): Promise<Setup & { epicTip: string; newTip: string }> {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-squash-rewritten-'));
    process.env.SWARMLOOP_ROOT = root;
    const { tree, clone } = featureWorktree(root, key);
    writeFileSync(join(tree, 'epic.ts'), 'epic v1\n');
    git(tree, ['add', 'epic.ts']);
    git(tree, ['commit', '-m', 'epic']);
    const epicTip = git(tree, ['rev-parse', 'HEAD']);
    git(tree, ['push', 'origin', 'HEAD:refs/heads/epic-ship']);
    git(clone, ['switch', 'main']);
    writeFileSync(join(clone, 'moved.ts'), 'export const moved = 1;\n');
    git(clone, ['add', 'moved.ts']);
    git(clone, ['commit', '-m', 'moved']);
    git(clone, ['push', 'origin', 'main']);
    git(clone, ['switch', '-c', 'epic-rewritten', 'main']);
    writeFileSync(join(clone, 'epic.ts'), 'epic v2\n');
    git(clone, ['add', 'epic.ts']);
    git(clone, ['commit', '-m', 'epic rewritten']);
    git(clone, ['push', '--force', 'origin', 'epic-rewritten:refs/heads/epic-ship']);
    const newTip = git(clone, ['rev-parse', 'HEAD']);
    const journal = memoryJournal();
    return {
      root,
      key,
      tree,
      oldHead: epicTip,
      base: newTip,
      epicTip,
      newTip,
      journal,
      rebase: () =>
        rebaseFeatureRepos({
          root,
          key,
          repos: ['demo'],
          branch: `feature/${key}-ship-the-field`,
          prompt: 'branch: epic-ship\n',
          denied: [],
          message: `feat(${key}): Ship the field`,
          hosts,
          journal,
          tips: { demo: [epicTip] },
        }),
    };
  }

  it('stands a part with no commit of its own on the new tip, with no commit and no parked conflict', async () => {
    const run = await rewritten('proj-f129-a');

    const stop = await run.rebase();

    expect(stop.kind).toBe('clean');
    expect(git(run.tree, ['rev-parse', 'HEAD'])).toBe(run.newTip);
    expect(existsSync(join(run.tree, git(run.tree, ['rev-parse', '--git-path', 'swarmloop-rebase'])))).toBe(false);
    expect(git(run.tree, ['status', '--porcelain'])).toBe('');
  });

  it('carries only the own commit of a part onto the new tip', async () => {
    const run = await rewritten('proj-f129-b');
    writeFileSync(join(run.tree, 'part.ts'), 'part\n');
    git(run.tree, ['add', 'part.ts']);
    git(run.tree, ['commit', '-m', 'part']);

    await run.rebase();

    expect(git(run.tree, ['rev-parse', 'HEAD~1'])).toBe(run.newTip);
    expect(git(run.tree, ['diff', '--name-only', 'HEAD~1', 'HEAD'])).toBe('part.ts');
    expect(git(run.tree, ['log', '-1', '--format=%s'])).toBe('feat(proj-f129-b): Ship the field');
  });

  it('takes again a conflict the squash from git merge base parked, and stands on the new tip', async () => {
    const run = await rewritten('proj-f129-c');
    // What the old squash left: the worktree at the new tip with the old epic's files, parked, and a journal entry with no ownBase.
    git(run.tree, ['update-ref', `refs/swarmloop/pre-rebase/feature/${run.key}-ship-the-field`, run.epicTip]);
    await run.journal.put('demo', {
      path: run.tree,
      branch: `feature/${run.key}-ship-the-field`,
      oldHead: run.epicTip,
      fingerprint: '',
      protectRef: `refs/swarmloop/pre-rebase/feature/${run.key}-ship-the-field`,
      expectedRemoteTip: null,
      baseSha: run.newTip,
      checkpoint: 'conflict',
    });
    git(run.tree, ['reset', '--hard', run.newTip]);
    writeFileSync(join(run.tree, 'epic.ts'), 'conflicting\n');
    const gitDir = git(run.tree, ['rev-parse', '--absolute-git-dir']);
    writeFileSync(join(gitDir, 'swarmloop-rebase'), `${run.newTip}\nfeat(${run.key}): Ship the field\n`);
    await run.journal.advance('demo', 'conflict', { fingerprint: await fingerprintOf(run.tree) });

    const stop = await run.rebase();

    expect(stop.kind).toBe('clean');
    expect(git(run.tree, ['rev-parse', 'HEAD'])).toBe(run.newTip);
    expect(git(run.tree, ['status', '--porcelain'])).toBe('');
    expect(existsSync(join(gitDir, 'swarmloop-rebase'))).toBe(false);
  });
});
