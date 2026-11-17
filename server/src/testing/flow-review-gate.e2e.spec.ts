import 'reflect-metadata';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { VisitRepository } from '../history/visit.repository';
import { stampGate, worktreesFingerprint } from '../steps/shared/gate';
import { createFlowHarness } from './flow-harness';
import { clearGitFaults, failGit } from './git-fault.spec-helpers';
import { BlockAgentRunner } from './result-answer';
import { git } from './runs.spec-helpers';

import type * as GitFault from './git-fault.spec-helpers';

jest.mock('child_process', () => jest.requireActual<typeof GitFault>('./git-fault.spec-helpers').faultyChildProcess());

const KEY = 'PROJ-445';

describe('the review stamps the files it read, and merge-request sends a stale review back', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  beforeEach(async () => {
    flow = await createFlowHarness(KEY, {
      blocks: new BlockAgentRunner(),
      realImplement: 'all',
      realReview: true,
      realHost: true,
      realSteps: ['commit'],
    });
    flow.fastWaits();
  });

  afterEach(async () => {
    clearGitFaults();
    jest.restoreAllMocks();
    await flow.close();
  });

  const runs = () => flow.app.app.get(RunRepository);
  const documents = () => flow.app.app.get(DocumentRepository);
  const steps = async () =>
    (await flow.app.app.get(VisitRepository).listStats((await runs().findRun(KEY))!.id)).map((v) => v.step);

  it('fails a review whose git probe fails, stamps nothing, and goes on to a merge request after a retry', async () => {
    const run = await flow.begin('merge-request');
    run.currentStep = 'code-review';
    await runs().saveRun(run);
    failGit(['rev-parse', '--show-toplevel'], { stderr: 'fatal: detected dubious ownership in repository' }, 2);

    const failed = await flow.app.pipeline.step('code-review', KEY);

    expect(failed.exitCode).toBe(1);
    expect(failed.message).toContain('dubious ownership');
    expect(await documents().latestStamp(KEY, 'review_quality')).toBeNull();

    await flow.person('resume');

    expect(flow.host.opened).toBe(1);
    const stamp = await documents().latestStamp(KEY, 'review_report');
    expect(stamp?.fingerprint).toBe(await worktreesFingerprint([flow.tree]));
  });

  it('goes back to code-review, finds nothing to commit and opens the request', async () => {
    const run = await flow.begin('merge-request');
    await stampGate(documents(), run, 'review_report', 'other files');
    const head = git(flow.tree, ['rev-parse', 'HEAD']);

    const back = await flow.app.pipeline.step('merge-request', KEY);
    expect(back.message).toContain('review was for other files: back to code-review');
    expect((await runs().findRun(KEY))?.currentStep).toBe('code-review');
    await flow.app.pipeline.step('code-review', KEY);
    const committed = await flow.app.pipeline.step('commit', KEY);
    expect(committed.message).toContain('commit done');
    const opened = await flow.app.pipeline.step('merge-request', KEY);

    expect(opened.exitCode).toBe(0);
    expect(git(flow.tree, ['rev-parse', 'HEAD'])).toBe(head);
    expect(flow.host.opened).toBe(1);
    expect((await steps()).filter((step) => !step.startsWith('code-review-'))).toEqual([
      'merge-request',
      'code-review',
      'commit',
      'merge-request',
    ]);
  });
});
