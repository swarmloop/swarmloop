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
import type { RebasedPublisher } from './rebased-publisher';

const run = { key: 'proj-91' } as RunEntity;
const branch = 'feature/proj-91-ship-the-field';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-merged-files-record-'));
  const config = { env: { SWARMLOOP_ROOT: root, GITLAB_TOKEN: '', GITHUB_TOKEN: '' } } as unknown as AppConfig;
  const stored: { kind: string; body: string }[] = [];
  const documents = {
    putDocument: async (_run: RunEntity, kind: string, body: string) => void stored.push({ kind, body }),
  } as unknown as DocumentRepository;
  const publisher = { hostsFor: async () => config.env } as unknown as RebasedPublisher;
  const record = new MergedFilesRecord({ config } as unknown as StepKernel, publisher, documents);
  return { root, stored, record };
}

function commitFiles(tree: string, names: string[]): string {
  for (const name of names) writeFileSync(join(tree, 'src', name), `${name}\n`);
  git(tree, ['add', '.']);
  git(tree, ['commit', '-m', 'files']);
  git(tree, ['push', 'origin', branch]);
  return git(tree, ['rev-parse', 'HEAD']);
}

describe('MergedFilesRecord', () => {
  afterEach(() => jest.restoreAllMocks());

  it('stores the files of the merge commit fetched from the target branch, not the files a plan named', async () => {
    const { root, stored, record } = await setup();
    const { tree } = featureWorktree(root, 'proj-91');
    const sha = commitFiles(tree, ['field.ts', 'helper.ts']);

    await record.record(run, { demo: sha }, async () => branch);

    expect(stored).toHaveLength(1);
    expect(stored[0]?.kind).toBe('merged_files');
    expect((stored[0]?.body ?? '').split('\n').sort()).toEqual(['src/field.ts', 'src/helper.ts']);
  });

  it('prefixes each path with its repository when the merge has several', async () => {
    const { root, stored, record } = await setup();
    const { tree: web } = featureWorktree(root, 'proj-91', 'web');
    const { tree: api } = featureWorktree(root, 'proj-91', 'api');

    await record.record(run, { web: commitFiles(web, ['a.ts']), api: commitFiles(api, ['b.ts']) }, async () => branch);

    expect((stored[0]?.body ?? '').split('\n').sort()).toEqual(['api/src/b.ts', 'web/src/a.ts']);
  });

  it('stores an empty document when no worktree of the run exists', async () => {
    const { stored, record } = await setup();

    await record.record(run, { demo: 'abc' }, async () => branch);

    expect(stored).toEqual([{ kind: 'merged_files', body: '' }]);
  });

  it('stores none, warns and does not throw when git cannot read the merge', async () => {
    const { root, stored, record } = await setup();
    commitFiles(featureWorktree(root, 'proj-91').tree, ['field.ts']);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(record.record(run, { demo: 'not-a-commit' }, async () => branch)).resolves.toBeUndefined();

    expect(stored).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('The files of the merge of proj-91 were not read'));
  });
});
