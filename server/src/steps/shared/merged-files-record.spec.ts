import { Logger } from '@nestjs/common';
import { writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AppConfig } from '../../config/env';
import type { DocumentRepository } from '../../history/document.repository';
import type { RunEntity } from '../../history/entities';
import { featureWorktree, git } from '../../testing/runs.spec-helpers';
import type { StepKernel } from '../step-kernel';
import { MergedFilesRecord } from './merged-files-record';

const branch = 'feature/proj-91-ship-the-field';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-merged-files-record-'));
  const config = { env: { SWARMLOOP_ROOT: root, GITLAB_TOKEN: '', GITHUB_TOKEN: '' } } as unknown as AppConfig;
  const stored: { kind: string; body: string }[] = [];
  const documents = {
    putDocument: async (_run: RunEntity, kind: string, body: string) => void stored.push({ kind, body }),
  } as unknown as DocumentRepository;
  const record = new MergedFilesRecord({ config } as unknown as StepKernel, documents);
  return { root, stored, record };
}

function commitFiles(tree: string, names: string[]): string {
  for (const name of names) writeFileSync(join(tree, 'src', name), `${name}\n`);
  git(tree, ['add', '.']);
  git(tree, ['commit', '-m', 'files']);
  git(tree, ['push', 'origin', branch]);
  return git(tree, ['rev-parse', 'HEAD']);
}

/** The run with the base tip its worktree was made from, as the prepare step records it. */
function runAt(tree: string, repo = 'demo'): RunEntity {
  return { key: 'proj-91', baseTips: { [repo]: git(tree, ['rev-parse', 'HEAD']) } } as unknown as RunEntity;
}

const headsOf = (heads: Record<string, string>) => async (repo: string) => heads[repo] ?? '';

/** How the host puts the two commits of the branch on main after an unrelated commit landed there. */
const METHODS: Record<string, (clone: string, first: string, last: string) => void> = {
  rebase: (clone, first, last) => git(clone, ['cherry-pick', first, last]),
  squash: (clone) => {
    git(clone, ['merge', '--squash', branch]);
    git(clone, ['commit', '-m', 'squashed']);
  },
  'merge commit': (clone) => git(clone, ['merge', '--no-ff', '-m', 'merged', branch]),
};

describe('MergedFilesRecord', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(Object.keys(METHODS))(
    'stores both files of a %s merge of two commits, not the last commit only',
    async (method) => {
      const { root, stored, record } = await setup();
      const { tree, clone } = featureWorktree(root, 'proj-91');
      const run = runAt(tree);
      const first = commitFiles(tree, ['a.ts']);
      const head = commitFiles(tree, ['b.ts']);
      writeFileSync(join(clone, 'unrelated.txt'), 'other\n');
      git(clone, ['add', '.']);
      git(clone, ['commit', '-m', 'unrelated']);
      METHODS[method]?.(clone, first, head);

      await record.record(run, ['demo'], headsOf({ demo: head }));

      expect(stored).toHaveLength(1);
      expect(stored[0]?.kind).toBe('merged_files');
      expect((stored[0]?.body ?? '').split('\n').sort()).toEqual(['src/a.ts', 'src/b.ts']);
    },
  );

  it('prefixes each path with its repository when the merge has several', async () => {
    const { root, stored, record } = await setup();
    const { tree: web } = featureWorktree(root, 'proj-91', 'web');
    const { tree: api } = featureWorktree(root, 'proj-91', 'api');
    const run = {
      key: 'proj-91',
      baseTips: { ...runAt(web, 'web').baseTips, ...runAt(api, 'api').baseTips },
    } as RunEntity;

    await record.record(
      run,
      ['web', 'api'],
      headsOf({ web: commitFiles(web, ['a.ts']), api: commitFiles(api, ['b.ts']) }),
    );

    expect((stored[0]?.body ?? '').split('\n').sort()).toEqual(['api/src/b.ts', 'web/src/a.ts']);
  });

  it('stores an empty document when no worktree of the run exists', async () => {
    const { stored, record } = await setup();

    await record.record({ key: 'proj-91' } as RunEntity, ['demo'], headsOf({ demo: 'abc' }));

    expect(stored).toEqual([{ kind: 'merged_files', body: '' }]);
  });

  it('stores none and warns when the run has no recorded base tip', async () => {
    const { root, stored, record } = await setup();
    const head = commitFiles(featureWorktree(root, 'proj-91').tree, ['a.ts']);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await record.record({ key: 'proj-91', baseTips: null } as RunEntity, ['demo'], headsOf({ demo: head }));

    expect(stored).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('proj-91 has no recorded base tip in demo'));
  });

  it('stores none, warns and does not throw when git cannot read the merge', async () => {
    const { root, stored, record } = await setup();
    const { tree } = featureWorktree(root, 'proj-91');
    const run = runAt(tree);
    commitFiles(tree, ['field.ts']);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(record.record(run, ['demo'], headsOf({ demo: 'not-a-commit' }))).resolves.toBeUndefined();

    expect(stored).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('The files of the merge of proj-91 were not read'));
  });
});
