import { existsSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import type { AppConfig } from '../config/env';
import type { Clock } from '../core/clock';
import type { RunEntity } from '../history/entities';
import * as fetchModule from '../git/rebase/fetch';
import { git as runGit } from '../git/git';
import { withWorktree } from '../git/worktree-lock';
import { featureWorktree, git } from '../testing/runs.spec-helpers';
import type { BaseTips } from '../steps/shared/base-tips';
import { SubtaskWorktrees } from './subtask-worktrees';

/** The record of what a run stood on, kept in memory: `stood` is what it knows, `recorded` what it was told since. */
function memoryTips(stood: string[] = []): { tips: BaseTips; recorded: Record<string, string>[] } {
  const recorded: Record<string, string>[] = [];
  const tips = {
    known: (_run: RunEntity, repos: string[]) =>
      Promise.resolve(Object.fromEntries(repos.map((repo) => [repo, stood]))),
    record: (_run: RunEntity, tip: Record<string, string>) => {
      recorded.push(tip);
      return Promise.resolve();
    },
  } as unknown as BaseTips;
  return { tips, recorded };
}

/**
 * An epic branch on origin that was rewritten after `tree` took it: main moved, and the branch was made again on the new
 * main with another `epic.ts`. Returns the tip `tree` stands on and the tip origin has now.
 */
function rewriteEpicOnOrigin(tree: string, clone: string, branch: string): { oldTip: string; newTip: string } {
  writeFileSync(join(tree, 'src', 'epic.ts'), 'epic v1\n');
  git(tree, ['add', '.']);
  git(tree, ['commit', '-m', 'epic']);
  const oldTip = git(tree, ['rev-parse', 'HEAD']);
  git(tree, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
  git(clone, ['switch', 'main']);
  writeFileSync(join(clone, 'src', 'moved.ts'), 'moved\n');
  git(clone, ['add', '.']);
  git(clone, ['commit', '-m', 'moved']);
  git(clone, ['push', 'origin', 'main']);
  git(clone, ['switch', '-c', 'epic-rewritten', 'main']);
  writeFileSync(join(clone, 'src', 'epic.ts'), 'epic v2\n');
  git(clone, ['add', '.']);
  git(clone, ['commit', '-m', 'epic rewritten']);
  git(clone, ['push', '--force', 'origin', `epic-rewritten:refs/heads/${branch}`]);
  return { oldTip, newTip: git(clone, ['rev-parse', 'HEAD']) };
}

describe('the files a task changed by its merge', () => {
  it('lists the files of the merge commit, not the files the plan named', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-merged-files-'));
    const { tree } = featureWorktree(root, 'proj-91');
    const branch = 'feature/proj-91-ship-the-field';
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    writeFileSync(join(tree, 'src', 'helper.ts'), 'export const helper = 1;\n');
    git(tree, ['add', '.']);
    git(tree, ['commit', '-m', 'field']);
    git(tree, ['push', 'origin', branch]);
    const sha = git(tree, ['rev-parse', 'HEAD']);
    const config = { env: { SWARMLOOP_ROOT: root, GITLAB_TOKEN: '', GITHUB_TOKEN: '' } } as unknown as AppConfig;
    const clock: Clock = { now: () => 0, iso: () => '2026-11-13T00:00:00.000Z' };

    const files = await new SubtaskWorktrees(config, clock, memoryTips().tips).changedFiles(
      { key: 'proj-91' } as RunEntity,
      { demo: sha },
      branch,
    );

    expect(files.sort()).toEqual(['src/field.ts', 'src/helper.ts']);
  });
});

describe('moving the worktree of the parent to the feature branch', () => {
  const branch = 'feature/proj-92-ship-the-field';
  const clock: Clock = { now: () => 0, iso: () => '2026-11-13T00:00:00.000Z' };
  const setup = async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-fast-forward-'));
    const { tree } = featureWorktree(root, 'proj-92');
    const config = { env: { SWARMLOOP_ROOT: root, GITLAB_TOKEN: '', GITHUB_TOKEN: '' } } as unknown as AppConfig;
    const commit = (name: string) => {
      writeFileSync(join(tree, 'src', name), `${name}\n`);
      git(tree, ['add', '.']);
      git(tree, ['commit', '-m', name]);
      return git(tree, ['rev-parse', 'HEAD']);
    };
    const run = { key: 'proj-92' } as RunEntity;
    return {
      tree,
      commit,
      move: () => new SubtaskWorktrees(config, clock, memoryTips().tips).fastForward(run, ['demo'], branch),
    };
  };

  it('moves the parent worktree to the feature branch and reports nothing', async () => {
    const { tree, commit, move } = await setup();
    const tip = commit('a.ts');
    git(tree, ['push', 'origin', branch]);
    git(tree, ['reset', '--hard', 'HEAD~1']);

    expect(await move()).toBeNull();
    expect(git(tree, ['rev-parse', 'HEAD'])).toBe(tip);
  });

  it('reports both heads and leaves the worktree when it has commits the feature branch lacks', async () => {
    const { tree, commit, move } = await setup();
    const remote = commit('a.ts');
    git(tree, ['push', 'origin', branch]);
    git(tree, ['reset', '--hard', 'HEAD~1']);
    const local = commit('b.ts');

    const note = await move();

    expect(note).toContain(local);
    expect(note).toContain(remote);
    expect(git(tree, ['rev-parse', 'HEAD'])).toBe(local);
  });
});

describe('committing the own edits of the parent before it is brought to the feature branch', () => {
  const branch = 'feature/proj-93-ship-the-field';
  const clock: Clock = { now: () => 0, iso: () => '2026-11-13T00:00:00.000Z' };
  const lines = (first: string, fifth = 'five') => [first, 'two', 'three', 'four', fifth, ''].join('\n');
  const setup = async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-own-edits-'));
    const { tree } = featureWorktree(root, 'proj-93');
    const config = { env: { SWARMLOOP_ROOT: root, GITLAB_TOKEN: '', GITHUB_TOKEN: '' } } as unknown as AppConfig;
    const shared = join(tree, 'src', 'shared.ts');
    writeFileSync(shared, lines('one'));
    git(tree, ['add', '.']);
    git(tree, ['commit', '-m', 'shared']);
    // The host gets a commit the worktree of the parent does not have yet: a merged task changed line 1.
    writeFileSync(shared, lines('task one'));
    git(tree, ['commit', '-am', 'task']);
    git(tree, ['push', 'origin', branch]);
    const tip = git(tree, ['rev-parse', 'HEAD']);
    git(tree, ['reset', '--hard', 'HEAD~1']);
    const commit = (park = false) =>
      new SubtaskWorktrees(config, clock, memoryTips().tips).commitOwnEdits(
        { key: 'proj-93' } as RunEntity,
        ['demo'],
        branch,
        async () => ({ message: () => 'own edits', author: null }),
        park,
      );
    return { tree, shared, tip, commit };
  };

  it('leaves a clean parent tree as it is and reports nothing', async () => {
    const { tree, commit } = await setup();
    const head = git(tree, ['rev-parse', 'HEAD']);

    expect(await commit()).toEqual({ committed: null, conflict: null });
    expect(git(tree, ['rev-parse', 'HEAD'])).toBe(head);
  });

  it('commits edits to other lines on top of the feature branch and names the paths', async () => {
    const { tree, shared, tip, commit } = await setup();
    writeFileSync(shared, lines('one', 'own five'));
    writeFileSync(join(tree, 'src', 'own.ts'), 'own\n');

    const result = await commit();

    expect(result.conflict).toBeNull();
    expect(result.committed).toContain('src/shared.ts');
    expect(result.committed).toContain('src/own.ts');
    expect(git(tree, ['rev-parse', 'HEAD~1'])).toBe(tip);
    expect(git(tree, ['status', '--porcelain'])).toBe('');
  });

  it('leaves conflicting edits uncommitted and names the file and both heads', async () => {
    const { tree, shared, tip, commit } = await setup();
    const head = git(tree, ['rev-parse', 'HEAD']);
    writeFileSync(shared, lines('own one'));

    const result = await commit();

    expect(result.committed).toBeNull();
    expect(result.conflict).toContain('src/shared.ts');
    expect(result.conflict).toContain(head);
    expect(result.conflict).toContain(tip);
    expect(result.conflict).not.toMatch(/CONFLICT|fatal:/);
    expect(result.conflict).not.toContain('resolve the files');
    expect(git(tree, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(tree, ['status', '--porcelain'])).toContain('src/shared.ts');
  });

  it('parks conflicting edits on top of the feature branch for the agent', async () => {
    const { tree, shared, tip, commit } = await setup();
    writeFileSync(shared, lines('own one'));

    const result = await commit(true);

    expect(result.conflict).toContain('src/shared.ts');
    expect(result.conflict).toContain('implement agent resolves');
    expect(existsSync(resolve(tree, git(tree, ['rev-parse', '--git-path', 'rebase-merge'])))).toBe(true);
    expect(git(tree, ['diff', '--name-only', '--diff-filter=U'])).toBe('src/shared.ts');
    expect(git(tree, ['rev-parse', 'HEAD'])).toBe(tip);
    expect(git(tree, ['rev-parse', 'refs/remotes/origin/feature/proj-93-ship-the-field'])).toBe(tip);
  });
});

describe('asking a subtask worktree for the tip while another operation holds it', () => {
  const branch = 'feature/proj-94-ship-the-field';
  const clock: Clock = { now: () => 0, iso: () => '2026-11-13T00:00:00.000Z' };

  it('starts the fetch only after the holder ends, and then finds the worktree on top', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-behind-tip-'));
    const { tree } = featureWorktree(root, 'proj-94');
    const config = { env: { SWARMLOOP_ROOT: root, GITLAB_TOKEN: '', GITHUB_TOKEN: '' } } as unknown as AppConfig;
    writeFileSync(join(tree, 'src', 'a.ts'), 'a\n');
    git(tree, ['add', '.']);
    git(tree, ['commit', '-m', 'a']);
    git(tree, ['push', 'origin', branch]);
    const tip = git(tree, ['rev-parse', 'HEAD']);
    git(tree, ['reset', '--hard', 'HEAD~1']);
    const order: string[] = [];
    const fetched = fetchModule.fetchBranch.bind(fetchModule);
    jest.spyOn(fetchModule, 'fetchBranch').mockImplementation((...args) => {
      order.push('fetch-start');
      return fetched(...args);
    });
    const run = { key: 'proj-94' } as RunEntity;
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => (entered = resolve));

    // The hold stands in for a rebase; the caller is another async context, so it must wait.
    const hold = withWorktree(tree, async () => {
      entered();
      await runGit(['-C', tree, 'reset', '--hard', tip]);
      order.push('rebase-end');
    });
    await inside;
    const behind = new SubtaskWorktrees(config, clock, memoryTips().tips).behindTip(run, run, ['demo'], branch);
    await hold;

    expect(await behind).toBeNull();
    expect(order).toEqual(['rebase-end', 'fetch-start']);
  });
});

describe('bringing a subtask worktree up to a feature branch that was rewritten', () => {
  const clock: Clock = { now: () => 0, iso: () => '2026-11-13T00:00:00.000Z' };

  it('replays only the own change of the subtask on the new tip, and records that tip', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-catch-up-'));
    const { tree, clone } = featureWorktree(root, 'proj-95');
    const config = { env: { SWARMLOOP_ROOT: root, GITLAB_TOKEN: '', GITHUB_TOKEN: '' } } as unknown as AppConfig;
    const { oldTip, newTip } = rewriteEpicOnOrigin(tree, clone, 'feature/epic-ship');
    writeFileSync(join(tree, 'src', 'part.ts'), 'part\n');
    git(tree, ['add', '.']);
    git(tree, ['commit', '-m', 'part']);
    const { tips, recorded } = memoryTips([oldTip]);

    await new SubtaskWorktrees(config, clock, tips).catchUp(
      { key: 'proj-95' } as RunEntity,
      ['demo'],
      'feature/epic-ship',
    );

    expect(git(tree, ['rev-parse', 'HEAD~1'])).toBe(newTip);
    expect(git(tree, ['diff', '--name-only', 'HEAD~1', 'HEAD'])).toBe('src/part.ts');
    expect(recorded).toEqual([{ demo: newTip }]);
  });

  it('commits the own edits of the parent on the new tip without the old commits of the branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-own-edits-rewritten-'));
    const { tree, clone } = featureWorktree(root, 'proj-96');
    const config = { env: { SWARMLOOP_ROOT: root, GITLAB_TOKEN: '', GITHUB_TOKEN: '' } } as unknown as AppConfig;
    const branch = 'feature/proj-96-ship-the-field';
    const { oldTip, newTip } = rewriteEpicOnOrigin(tree, clone, branch);
    writeFileSync(join(tree, 'src', 'own.ts'), 'own\n');

    const result = await new SubtaskWorktrees(config, clock, memoryTips([oldTip]).tips).commitOwnEdits(
      { key: 'proj-96' } as RunEntity,
      ['demo'],
      branch,
      async () => ({ message: () => 'own edits', author: null }),
      false,
    );

    expect(result.conflict).toBeNull();
    expect(git(tree, ['rev-parse', 'HEAD~1'])).toBe(newTip);
    expect(git(tree, ['diff', '--name-only', 'HEAD~1', 'HEAD'])).toBe('src/own.ts');
  });

  it('keeps a local commit of the parent that origin lacks, with its uncommitted edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-own-edits-ahead-'));
    const { tree } = featureWorktree(root, 'proj-97');
    const config = { env: { SWARMLOOP_ROOT: root, GITLAB_TOKEN: '', GITHUB_TOKEN: '' } } as unknown as AppConfig;
    const branch = 'feature/proj-97-ship-the-field';
    git(tree, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
    const remoteTip = git(tree, ['rev-parse', 'HEAD']);
    writeFileSync(join(tree, 'src', 'local.ts'), 'local\n');
    git(tree, ['add', '.']);
    git(tree, ['commit', '-m', 'local']);
    writeFileSync(join(tree, 'src', 'own.ts'), 'own\n');

    const result = await new SubtaskWorktrees(config, clock, memoryTips([remoteTip]).tips).commitOwnEdits(
      { key: 'proj-97' } as RunEntity,
      ['demo'],
      branch,
      async () => ({ message: () => 'own edits', author: null }),
      false,
    );

    expect(result.conflict).toBeNull();
    expect(git(tree, ['rev-parse', 'HEAD~2'])).toBe(remoteTip);
    expect(git(tree, ['diff', '--name-only', 'HEAD~2', 'HEAD']).split('\n').sort()).toEqual([
      'src/local.ts',
      'src/own.ts',
    ]);
  });
});
