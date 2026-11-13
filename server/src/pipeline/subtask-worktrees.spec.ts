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
