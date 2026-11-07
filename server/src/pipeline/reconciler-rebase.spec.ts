import 'reflect-metadata';
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ERROR_CODES } from '../contract/error-codes';
import { REBASE_JOURNAL, fingerprintOf } from '../git/rebase';
import type { Journal } from '../git/rebase';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { RunRebase } from '../steps/run-rebase';
import { createTestApp } from '../testing/test-app';
import type { TestApp } from '../testing/test-app';
import { Reconciler } from './reconciler';

const KEY = 'PROJ-1';

async function journaled(app: TestApp, checkpoint: 'applied' | 'conflict', fingerprint?: string) {
  const path = join(app.root, 'worktrees', KEY, 'demo');
  mkdirSync(path, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', path]);
  writeFileSync(join(path, 'a.txt'), 'a\n');
  const run = await app.app.get(RunRepository).begin(KEY, 'implement');
  const journal: Journal = {
    demo: {
      path,
      branch: 'feature/proj-1',
      oldHead: 'a',
      fingerprint: fingerprint ?? (await fingerprintOf(path)),
      protectRef: 'refs/swarmloop/pre-rebase/feature/proj-1',
      expectedRemoteTip: null,
      baseSha: 'b',
      checkpoint,
      generation: run.generation,
    },
  };
  await app.app.get(DocumentRepository).putDocument(run, REBASE_JOURNAL, `${JSON.stringify(journal)}\n`);
  return run;
}

describe('reconciler and the rebase journal', () => {
  let app: TestApp;

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  it('resumes an unfinished journal through the rebase, without a new generation', async () => {
    app = await createTestApp();
    const run = await journaled(app, 'applied');
    const rebase = jest.spyOn(app.app.get(RunRebase), 'rebase').mockResolvedValue('resume');

    await app.app.get(Reconciler).reconcile(run);

    expect(rebase).toHaveBeenCalledWith(KEY, true);
    const settled = await app.app.get(RunRepository).findRun(KEY);
    expect(settled).toMatchObject({ status: 'failed', generation: 0 });
  });

  it('blocks with REBASE_CONFLICT, naming the repo, when the files no longer match the journal', async () => {
    app = await createTestApp();
    const run = await journaled(app, 'applied', 'files of the last checkpoint');
    const rebase = jest.spyOn(app.app.get(RunRebase), 'rebase');

    await app.app.get(Reconciler).reconcile(run);

    expect(rebase).not.toHaveBeenCalled();
    const blocked = await app.app.get(RunRepository).findRun(KEY);
    expect(blocked?.status).toBe('blocked');
    expect(JSON.parse(blocked?.stateReason ?? '{}')).toEqual({
      code: ERROR_CODES.REBASE_CONFLICT,
      message: 'demo rebase blocked: the files changed since the journal was written',
    });
  });

  it('leaves a repo in conflict to a person', async () => {
    app = await createTestApp();
    const run = await journaled(app, 'conflict');
    const rebase = jest.spyOn(app.app.get(RunRebase), 'rebase');

    await app.app.get(Reconciler).reconcile(run);

    expect(rebase).not.toHaveBeenCalled();
    expect((await app.app.get(RunRepository).findRun(KEY))?.status).not.toBe('blocked');
  });
});
