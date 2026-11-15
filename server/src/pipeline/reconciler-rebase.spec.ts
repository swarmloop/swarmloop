import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ERROR_CODES } from '../contract/error-codes';
import { REBASE_JOURNAL, fingerprintOf } from '../git/rebase';
import type { Journal } from '../git/rebase';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { RunRebase } from '../steps/run-rebase';
import { git } from '../testing/git-fixture';
import { createTestApp } from '../testing/test-app';
import type { TestApp } from '../testing/test-app';
import { HostUnavailable, SwarmloopError } from '../core/swarmloop-error';
import { Reconciler } from './reconciler';
import { WorkspaceGuard } from './workspace-guard';

let counter = 0;
const nextKey = () => `PROJ-${++counter}`;

async function journaled(app: TestApp, key: string, checkpoint: 'applied' | 'conflict', fingerprint?: string) {
  const path = join(app.root, 'worktrees', key, 'demo');
  mkdirSync(path, { recursive: true });
  git(app.root, ['init', '-q', '-b', 'main', path]);
  writeFileSync(join(path, 'a.txt'), 'a\n');
  const run = await app.app.get(RunRepository).begin(key, 'implement');
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

let app: TestApp;
let key: string;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  key = nextKey();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('reconciler and the rebase journal', () => {
  it('resumes an unfinished journal through the rebase, without a new generation', async () => {
    const run = await journaled(app, key, 'applied');
    const rebase = jest.spyOn(app.app.get(RunRebase), 'rebase').mockResolvedValue('resume');

    await app.app.get(Reconciler).reconcile(run);

    expect(rebase).toHaveBeenCalledWith(key, true);
    const settled = await app.app.get(RunRepository).findRun(key);
    expect(settled).toMatchObject({ status: 'failed', generation: 0 });
  });

  it('blocks with REBASE_CONFLICT, naming the repo, when the files no longer match the journal', async () => {
    const run = await journaled(app, key, 'applied', 'files of the last checkpoint');
    const rebase = jest.spyOn(app.app.get(RunRebase), 'rebase');

    await app.app.get(Reconciler).reconcile(run);

    expect(rebase).not.toHaveBeenCalled();
    const blocked = await app.app.get(RunRepository).findRun(key);
    expect(blocked?.status).toBe('blocked');
    expect(JSON.parse(blocked?.stateReason ?? '{}')).toEqual({
      code: ERROR_CODES.REBASE_CONFLICT,
      message: 'demo rebase blocked: the files changed since the journal was written',
    });
  });

  it('leaves the run as it was and tries again on the next tick when the host does not answer', async () => {
    const run = await journaled(app, key, 'applied');
    const outage = new HostUnavailable('api.github.com', 'HTTP 503', '2026-11-12T15:00:00.000Z');
    const tried: string[] = [];
    jest.spyOn(app.app.get(RunRebase), 'rebase').mockImplementation(async (ran) => {
      tried.push(ran);
      if (tried.length === 1) throw outage;
      return 'resume';
    });

    await app.app.get(Reconciler).reconcile(run);
    const waiting = await app.app.get(RunRepository).findRun(key);
    expect(waiting).toMatchObject({ status: run.status, stateReason: run.stateReason });
    expect(waiting?.stateReason ?? '').not.toContain(ERROR_CODES.REBASE_CONFLICT);

    await app.app.get(Reconciler).reconcile(waiting!);
    expect(tried).toEqual([key, key]);
  });

  it('leaves a repo in conflict to a person', async () => {
    const run = await journaled(app, key, 'conflict');
    const rebase = jest.spyOn(app.app.get(RunRebase), 'rebase');

    await app.app.get(Reconciler).reconcile(run);

    expect(rebase).not.toHaveBeenCalled();
    expect((await app.app.get(RunRepository).findRun(key))?.status).not.toBe('blocked');
  });
});

describe('reconciler and a workspace that cannot be restored', () => {
  it.each([ERROR_CODES.WORKSPACE_LOST, ERROR_CODES.BRANCH_IN_USE, ERROR_CODES.BRANCH_DIVERGED])(
    'blocks with %s and never relaunches',
    async (code) => {
      const run = await journaled(app, key, 'applied');
      jest.spyOn(app.app.get(WorkspaceGuard), 'ensure').mockRejectedValue(new SwarmloopError('demo cannot', { code }));
      const rebase = jest.spyOn(app.app.get(RunRebase), 'rebase');

      await app.app.get(Reconciler).reconcile(run);

      expect(rebase).not.toHaveBeenCalled();
      const blocked = await app.app.get(RunRepository).findRun(key);
      expect(blocked?.status).toBe('blocked');
      expect(JSON.parse(blocked?.stateReason ?? '{}')).toEqual({ code, message: 'demo cannot' });
    },
  );
});
