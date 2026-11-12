import 'reflect-metadata';

import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { DocumentRepository } from '../../history/document.repository';
import { EventRepository } from '../../history/event.repository';
import { readLoopDetail } from '../../history/loop-detail';
import { RunRepository } from '../../history/run.repository';
import { VisitRepository } from '../../history/visit.repository';
import { PipelineService } from '../../pipeline/pipeline.service';
import { featureWorktree, git, visit } from '../../testing/runs.spec-helpers';
import { boot, call, job, seed, shot } from './pipeline.step.spec-helpers';

const PROJECT = 'group/demo';

/** CI failed `docker` on the worktree's commit; `checks` is what the latest checks visit stored, or null for no visit. */
async function returned(
  key: string,
  checks: { status: string; trees: (tree: string) => Record<string, string> } | null,
) {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-ci-only-'));
  const { tree } = featureWorktree(root, key);
  git(tree, ['remote', 'set-url', 'origin', `https://gitlab.example/${PROJECT}.git`]);
  const sha = git(tree, ['rev-parse', 'HEAD']).trim();
  const content = git(tree, ['rev-parse', 'HEAD^{tree}']).trim();
  const read = jest.fn(() =>
    Promise.resolve({ snapshot: shot('failed', [job(7, 'docker', false)]), httpCalls: [call('GET')] }),
  );
  const app = await boot(
    root,
    read,
    jest.fn(() => Promise.resolve({ trace: 'log\n', httpCalls: [call('GET')] })),
  );
  try {
    await seed(app, key, `project: ${PROJECT}\nref: feature/${key}\nsha: ${sha}\n`);
    const run = (await app.get(RunRepository).findRun(key))!;
    await app.get(DocumentRepository).putDocument(run, 'repos', 'demo\n');
    if (checks) {
      await app
        .get(VisitRepository)
        .finishVisit(run, { ...visit('checks', checks.status), checkedCommits: checks.trees(content) });
    }
    await app.get(PipelineService).step('pipeline', key);
    const [loop] = await app.get(EventRepository).listLoops(run.id);
    return { reason: loop.reason, detail: readLoopDetail(loop.detail), counter: loop.counter };
  } finally {
    await app.close();
  }
}

describe('pipeline step: CI-only returns', () => {
  it('names the failed job when the checks passed on the same content', async () => {
    const loop = await returned('PROJ-801', { status: 'done', trees: (tree) => ({ [PROJECT]: tree }) });

    expect(loop.counter).toBe('pipeline');
    expect(loop.reason).toBe('CI job docker failed; no check covers it');
    expect(loop.detail).toEqual({ ciOnly: true, jobs: ['docker'] });
  });

  it.each([
    [
      'the checks visit stored no content (it failed or was skipped)',
      'PROJ-802',
      { status: 'waiting', trees: () => ({}) },
    ],
    ['the checks ran on other content', 'PROJ-803', { status: 'done', trees: () => ({ [PROJECT]: 'other' }) }],
    ['no checks visit exists', 'PROJ-804', null],
  ])("keeps today's reason when %s", async (_name, key, checks) => {
    const loop = await returned(key, checks);

    expect(loop.reason).toBe(`${PROJECT} docker`);
    expect(loop.detail).toEqual({ ciOnly: false, jobs: ['docker'] });
  });
});
