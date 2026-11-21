import 'reflect-metadata';

import { existsSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FakeClock } from '../../core/fake-clock.spec-helpers';
import { featureWorktree, git } from '../../testing/runs.spec-helpers';
import { withWorktree } from '../worktree-lock';
import { rebaseFeatureRepos } from '.';
import { completeRebase } from './journal';
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

  it('starts no git in the worktree while another operation holds it', async () => {
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
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = withWorktree(run.tree, () => gate);
    const rebased = run.rebase();
    await arrived;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(gitCalls).not.toHaveBeenCalled();
    release();
    await held;
    await rebased;
    expect(gitCalls).toHaveBeenCalled();
    expect(git(run.tree, ['rev-parse', 'HEAD^'])).toBe(run.base);
  });
});
