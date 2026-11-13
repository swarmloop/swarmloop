import 'reflect-metadata';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { DocumentRepository } from '../history/document.repository';
import { actionsFor, NEEDS_PERSON } from '../contract/run-state';
import { deriveState } from '../history/run-state';
import { RunRepository } from '../history/run.repository';
import { putStamped } from '../steps/shared/gate.spec-helpers';
import { createFlowHarness } from './flow-harness';
import { assertInvariants } from './flow-invariants';
import { git } from './runs.spec-helpers';

const KEY = 'PROJ-430';
const PROJECT = 'group/demo';
const SOURCE = `feature/${KEY}-ship-the-field`;

describe('the real merge-request and pipeline steps on the fake host', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  beforeEach(async () => {
    flow = await createFlowHarness(KEY, { realHost: true });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  const find = async () => (await flow.app.app.get(RunRepository).findRun(KEY))!;
  const stateNow = async () => deriveState(await find());
  const head = () => git(flow.tree, ['rev-parse', 'HEAD']);
  const request = async () => (await flow.host.findMergeRequest({ project: PROJECT, source: SOURCE })).record;

  /** One reconciler pass, the hops it starts, and the invariants. */
  async function tick(): Promise<void> {
    await flow.tick();
    await flow.app.pipeline.whenIdle(KEY);
    await assertInvariants(flow.app);
  }

  /** The branch gets a workflow file, so a commit with no run is a CI that did not start. Call it before `begin`. */
  function withWorkflowFile(): void {
    writeFileSync(join(flow.tree, '.gitlab-ci.yml'), 'test:\n  script: [true]\n');
    git(flow.tree, ['add', '.gitlab-ci.yml']);
    git(flow.tree, ['commit', '-m', 'ci: add the workflow']);
    git(flow.tree, ['push', 'origin', SOURCE]);
  }

  it('opens the request as a draft at merge-request, and the green pipeline marks it ready', async () => {
    await flow.begin('merge-request');
    flow.host.ci.pass(head());

    await flow.app.pipeline.step('merge-request', KEY);
    await flow.app.pipeline.whenIdle(KEY);
    expect(await request()).toMatchObject({ iid: 1, project: PROJECT, draft: true });
    expect((await find()).currentStep).toBe('pipeline');

    await flow.app.pipeline.runThrough(KEY);
    await tick();
    expect((await stateNow()).state).toBe('done');
    expect(await request()).toMatchObject({ iid: 1, draft: false });
  });

  it('reuses the request it finds on a second visit to merge-request', async () => {
    await flow.begin('merge-request');
    flow.host.ci.pass(head());

    await flow.app.pipeline.step('merge-request', KEY);
    await flow.app.pipeline.step('merge-request', KEY);
    await flow.app.pipeline.whenIdle(KEY);

    expect(flow.host.opened).toBe(1);
    expect(await request()).toMatchObject({ iid: 1 });
  });

  it('passes a pipeline that is green on arrival and goes to done', async () => {
    await flow.begin('pipeline');
    flow.host.ci.pass(head());

    await flow.app.pipeline.runThrough(KEY);
    await tick();

    expect((await stateNow()).state).toBe('done');
    expect((await find()).currentStep).toBe('done');
  });

  it('opens no request and starts no pipeline when CI is skipped for the run', async () => {
    const run = await flow.begin('merge-request');
    await flow.app.app.get(DocumentRepository).putDocument(run, 'ci_skip', 'CI is skipped: the project has no CI\n');
    await putStamped(flow.app.app, run, 'pipeline_ref', '', ['demo']);

    await flow.app.pipeline.runThrough(KEY);
    await tick();

    expect((await stateNow()).state).toBe('done');
    expect(flow.host.opened).toBe(0);
  });

  it('blocks a run whose request was closed while CI never started, and merges nothing', async () => {
    withWorkflowFile();
    flow.fastWaits();
    await flow.begin('merge-request');
    flow.host.ci.silent(head());
    await flow.app.pipeline.step('merge-request', KEY);
    await flow.app.pipeline.whenIdle(KEY);
    flow.host.closeRequest(1);

    await flow.app.pipeline.runThrough(KEY);
    const { state, reason } = await stateNow();
    expect(state).toBe('blocked');
    expect(reason?.message).toContain('merge request is closed');
    expect(actionsFor(state, reason?.code ?? null)).toContain(NEEDS_PERSON[reason?.code ?? '']);
    expect(flow.host.merged.size).toBe(0);

    await tick();
    expect(flow.host.merged.size).toBe(0);
  });

  it('rebases once for a merge conflict that kept CI from starting, and not again for the same commit', async () => {
    withWorkflowFile();
    flow.fastWaits();
    await flow.begin('merge-request');
    const stuck = head();
    flow.host.ci.silent(stuck);
    await flow.app.pipeline.step('merge-request', KEY);
    await flow.app.pipeline.whenIdle(KEY);
    flow.host.conflicts(true);

    await flow.app.pipeline.runThrough(KEY);
    await tick();
    expect((await find()).attemptsPipeline).toBe(1);
    expect(head()).not.toBe(stuck);

    git(flow.tree, ['reset', '--hard', stuck]);
    await flow.app.pipeline.step('pipeline', KEY);
    await tick();
    const { state, reason } = await stateNow();
    expect(state).toBe('blocked');
    expect(reason?.message).toContain('automatic rebase was already attempted for this SHA');
    expect(actionsFor(state, reason?.code ?? null)).toContain(NEEDS_PERSON[reason?.code ?? '']);
    expect((await find()).attemptsPipeline).toBe(1);
  });
});
