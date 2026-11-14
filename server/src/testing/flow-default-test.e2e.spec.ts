import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { DocumentRepository } from '../history/document.repository';
import { VisitRepository } from '../history/visit.repository';
import { deriveState } from '../history/run-state';
import { putStamped } from '../steps/shared/gate.spec-helpers';
import { RunRebase } from '../steps/run-rebase';
import { RunRepository } from '../history/run.repository';
import { createFlowHarness, useGitlabOrigin } from './flow-harness';
import { assertInvariants } from './flow-invariants';
import { BlockAgentRunner } from './result-answer';
import { git, remember } from './runs.spec-helpers';
import { CODE_REVIEWERS } from '../contract/steps';
import { reviewReport } from '../agent-result/definitions/review-report';

const KEY = 'PROJ-440';
const FEATURE = `feature/${KEY}-ship-the-field`;
const TEST_FILE = 'app/login/page.test.ts';
const LOG = `FAIL ${TEST_FILE}\n  Cannot find module '../page'\n`;

describe('a CI failure in a test only the default branch has is fixed by a rebase', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  beforeEach(async () => {
    flow = await createFlowHarness(KEY, { realHost: true });
    flow.fastWaits();
    // The scripted code-review and commit steps write no report and push nothing, so the rebase leaves what the real ones do.
    const rebase = flow.app.app.get(RunRebase);
    const original = rebase.rebase.bind(rebase);
    jest.spyOn(rebase, 'rebase').mockImplementation(async (...args) => {
      const next = await original(...args);
      git(flow.tree, ['push', '--force', 'origin', FEATURE]);
      const run = await find();
      const ref = `project: group/demo\nref: ${FEATURE}\nsha: ${git(flow.tree, ['rev-parse', 'HEAD'])}\n`;
      await putStamped(flow.app.app, run, 'pipeline_ref', ref, ['demo']);
      await putStamped(flow.app.app, run, 'review_report', '- the field ships\n', ['demo']);
      return next;
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  const find = async () => (await flow.app.app.get(RunRepository).findRun(KEY))!;
  const steps = async () =>
    (await flow.app.app.get(VisitRepository).listStats((await find()).id)).map((visit) => visit.step);

  /** The branch has a commit of its own, so a rebase has something to move. */
  function commitOnBranch(): void {
    writeFileSync(join(flow.tree, 'src', 'field.ts'), 'export const field = 1;\n');
    git(flow.tree, ['add', 'src/field.ts']);
    git(flow.tree, ['commit', '-m', 'feat: the field']);
    git(flow.tree, ['push', 'origin', FEATURE]);
  }

  /** The default branch gets the test file after the feature branch was made. */
  function landOnDefault(): void {
    const clone = join(flow.app.root, 'demo');
    git(clone, ['switch', 'main']);
    mkdirSync(join(clone, dirname(TEST_FILE)), { recursive: true });
    writeFileSync(join(clone, TEST_FILE), 'export {};\n');
    git(clone, ['add', TEST_FILE]);
    git(clone, ['commit', '-m', 'test: login page']);
    git(clone, ['push', 'origin', 'main']);
    git(clone, ['switch', 'holder']);
  }

  async function tick(): Promise<void> {
    await flow.tick();
    await flow.app.pipeline.whenIdle(KEY);
    await assertInvariants(flow.app);
  }

  it('rebases, passes CI, and never runs implement for it', async () => {
    commitOnBranch();
    landOnDefault();
    flow.host.requireFile(TEST_FILE, LOG);
    await flow.begin('pipeline');

    await flow.app.pipeline.runThrough(KEY);
    await tick();

    expect(deriveState(await find()).state).toBe('done');
    expect(git(flow.tree, ['cat-file', '-e', `HEAD:${TEST_FILE}`])).toBe('');
    expect((await find()).attemptsPipeline).toBe(0);
    expect(await steps()).not.toContain('implement');
  });

  it('returns a failure that remains after the rebase to implement, counts it, and rebases once per default head', async () => {
    commitOnBranch();
    landOnDefault();
    flow.host.ci.failBranch(FEATURE, LOG);
    await flow.begin('pipeline');

    await flow.app.pipeline.runThrough(KEY);
    await tick();

    const rebased = JSON.parse(
      (await flow.app.app.get(DocumentRepository).latestBody(KEY, 'pipeline_rebases')) ?? '[]',
    );
    expect(rebased).toHaveLength(1);
    expect((await find()).attemptsPipeline).toBeGreaterThanOrEqual(1);
    expect(await steps()).toContain('implement');
  });
});

describe('a whole run from requirements to done with every agent step answering in blocks', () => {
  const REVIEW_STEPS = CODE_REVIEWERS.map((name) => `code-review-${name}`);
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let blocks: BlockAgentRunner;

  beforeEach(async () => {
    blocks = new BlockAgentRunner();
    flow = await createFlowHarness(KEY, { blocks, realImplement: 'all', realReview: true, realHost: true });
    flow.fastWaits();
    // The real merge-request step needs a gitlab origin and a run on that host, as `begin` sets up for its steps.
    useGitlabOrigin(flow.app.root, flow.tree);
    const runs = flow.app.app.get(RunRepository);
    const run = await remember(runs, flow.app.app.get(DocumentRepository), KEY, 'requirements', 'waiting');
    run.codeHost = 'gitlab';
    await runs.saveRun(run);
    // The scripted commit step pushes nothing and leaves no pipeline ref, so the ref of the pushed head stands for it.
    const ref = `project: group/demo\nref: ${FEATURE}\nsha: ${git(flow.tree, ['rev-parse', 'HEAD'])}\n`;
    await putStamped(flow.app.app, run, 'pipeline_ref', ref, ['demo']);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  it('runs every agent step on its default block and ends done', async () => {
    await flow.app.pipeline.runThrough(KEY);
    for (let pass = 0; pass < 5; pass += 1) {
      await flow.tick();
      await flow.app.pipeline.whenIdle(KEY);
      await assertInvariants(flow.app);
    }

    const run = (await flow.app.app.get(RunRepository).findRun(KEY))!;
    expect(deriveState(run).state).toBe('done');
    expect(blocks.steps).toEqual(
      expect.arrayContaining([
        'research',
        'plan',
        'plan-improve',
        'implement',
        'implement-improve',
        ...REVIEW_STEPS,
        'code-review-report',
      ]),
    );
    const documents = flow.app.app.get(DocumentRepository);
    const kinds = [
      'research_result',
      'plan_result',
      'plan_improve_result',
      'implementation_result',
      'implementation_improve_result',
      reviewReport.kind,
      ...CODE_REVIEWERS.map((name) => `review_${name}_result`),
    ];
    for (const kind of kinds) {
      expect(await documents.latestBody(KEY, kind)).not.toBeNull();
    }
  });
});
