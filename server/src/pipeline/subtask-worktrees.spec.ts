import { writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AppConfig } from '../config/env';
import type { Clock } from '../core/clock';
import type { RunEntity } from '../history/entities';
import { featureWorktree, git } from '../testing/runs.spec-helpers';
import { SubtaskWorktrees } from './subtask-worktrees';

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

    const files = await new SubtaskWorktrees(config, clock).changedFiles(
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
    return { tree, commit, move: () => new SubtaskWorktrees(config, clock).fastForward(run, ['demo'], branch) };
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
