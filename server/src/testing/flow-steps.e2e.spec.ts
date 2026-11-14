import 'reflect-metadata';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { DocumentRepository } from '../history/document.repository';
import { CommandService } from '../pipeline/command.service';
import { actionsFor, NEEDS_PERSON } from '../contract/run-state';
import { deriveState } from '../history/run-state';
import { RunRepository } from '../history/run.repository';
import { putStamped } from '../steps/shared/gate.spec-helpers';
import { createFlowHarness } from './flow-harness';
import { assertInvariants } from './flow-invariants';
import { approvedRun, conflictingRebase, returnedTo } from './implement-flow.spec-helpers';
import { BlockAgentRunner } from './result-answer';
import { VisitRepository } from '../history/visit.repository';
import { REBASE_CONFLICT } from '../git/rebase';
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

describe('the real implement step in a whole flow', () => {
  const IMPLEMENT_KEY = 'PROJ-431';
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let blocks: BlockAgentRunner;

  const start = async (scripts: ConstructorParameters<typeof BlockAgentRunner>[0] = {}) => {
    blocks = new BlockAgentRunner(scripts);
    flow = await createFlowHarness(IMPLEMENT_KEY, { blocks, realImplement: 'all' });
  };
  const documents = () => flow.app.app.get(DocumentRepository);
  const runOf = () => flow.app.app.get(RunRepository).findRun(IMPLEMENT_KEY);

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  it('takes a checks return back to implement and goes on to done', async () => {
    await start({ implement: [{ block: { implementation: ['fixed the lint'], summary: ['the check now passes'] } }] });
    const run = await approvedRun(flow, IMPLEMENT_KEY, 'implement');
    await returnedTo(flow, run, '## checks\nFAIL npm run lint\n');

    await flow.person('resume');

    expect((await runOf())?.currentStep).toBe('done');
    expect(blocks.prompts.filter((launch) => launch.step === 'implement')).toHaveLength(1);
    expect(blocks.prompts[0]?.prompt).toContain('## checks\nFAIL npm run lint');
    expect(await documents().latestBody(IMPLEMENT_KEY, 'implementation')).toBe('- fixed the lint\n');
    await assertInvariants(flow.app);
  });

  it('takes a pipeline return that left the files unchanged to a CI rerun and on to done', async () => {
    await start();
    const run = await approvedRun(flow, IMPLEMENT_KEY, 'implement');
    await returnedTo(flow, run, '## pipeline\nresult: fail\njob: test\n\nAssertion failed\n');

    await flow.person('resume');

    expect((await runOf())?.currentStep).toBe('done');
    const prompts = blocks.prompts.filter((launch) => launch.step === 'implement').map((launch) => launch.prompt);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('The pipeline failure still stands and the files are unchanged.');
    expect(prompts[1]).toContain('End with the result block as before.');
    expect(prompts[1]).not.toContain('The object has these fields, and no others:');
    expect(await documents().latestBody(IMPLEMENT_KEY, 'ci_rerun')).not.toBeNull();
    await assertInvariants(flow.app);
  });

  it('moves a limit hit to the next runtime in a new chat with the full result text, and goes on to done', async () => {
    blocks = new BlockAgentRunner();
    flow = await createFlowHarness(IMPLEMENT_KEY, {
      blocks,
      realImplement: 'all',
      env: { AGENTS_IMPLEMENT: 'claude:m-claude,codex:m-codex', ANTHROPIC_API_KEY: 'key', CODEX_API_KEY: 'key' },
    });
    const delegate = blocks.run.bind(blocks);
    const seen: string[] = [];
    jest.spyOn(blocks, 'run').mockImplementation(async (input: { step: string; prompt?: string; runtime?: string }) => {
      seen.push(`${input.step}:${input.runtime}`);
      const answered = await delegate(input);
      return input.runtime === 'claude'
        ? {
            ...answered,
            responseText: "You've hit your 5-hour limit",
            limit: { window: '5-hour', resetsAt: new Date(flow.app.clock.now() + 3_600_000).toISOString() },
          }
        : answered;
    });
    await approvedRun(flow, IMPLEMENT_KEY, 'implement');

    await flow.person('resume');

    expect(seen.filter((step) => step.startsWith('implement'))).toEqual([
      'implement:claude',
      'implement:codex',
      'implement-improve:codex',
    ]);
    expect(blocks.steps).toContain('code-review-report');
    expect((await runOf())?.currentStep).toBe('done');
    expect(blocks.prompts[1]?.prompt).toContain('The object has these fields, and no others:');
    await assertInvariants(flow.app);
  });

  it('resolves a rebase conflict with the agent, keeps the first pass and goes on to done', async () => {
    await start({ rebase: [{ block: { summary: ['kept both sides of the field'] } }] });
    const run = await approvedRun(flow, IMPLEMENT_KEY, 'implement');
    await documents().putDocument(run, 'implementation', '- changed the field parser\n');
    conflictingRebase(flow);
    await documents().putDocument(run, REBASE_CONFLICT, 'pending\n');
    const delegate = blocks.run.bind(blocks);
    jest.spyOn(blocks, 'run').mockImplementation(async (input) => {
      if (input.prompt?.includes('The commit being replayed is')) {
        writeFileSync(join(flow.tree, 'src', 'readme.ts'), 'export const readme = 4;\n');
      }
      return delegate(input);
    });

    await flow.person('resume');

    expect(blocks.steps.filter((name) => name === 'rebase')).toHaveLength(1);
    expect(await documents().latestBody(IMPLEMENT_KEY, 'rebase_resolution_result')).toContain('kept both sides');
    expect(await documents().latestBody(IMPLEMENT_KEY, 'implementation')).toBe('- changed the field parser\n');
    expect(git(flow.tree, ['show', 'HEAD:src/readme.ts'])).toBe('export const readme = 4;');
    expect((await runOf())?.currentStep).toBe('done');
    await assertInvariants(flow.app);
  });

  it('sends the implementation definition after resolving a rebase in a new chat', async () => {
    await start();
    const run = await approvedRun(flow, IMPLEMENT_KEY, 'implement');
    conflictingRebase(flow);
    await documents().putDocument(run, REBASE_CONFLICT, 'pending-implement\n');
    const delegate = blocks.run.bind(blocks);
    jest.spyOn(blocks, 'run').mockImplementation(async (input) => {
      if (input.prompt?.includes('The commit being replayed is')) {
        writeFileSync(join(flow.tree, 'src', 'readme.ts'), 'export const readme = 4;\n');
      }
      return delegate(input);
    });

    await flow.person('resume');

    const prompt = blocks.prompts.find((launch) => launch.step === 'implement')?.prompt;
    expect(prompt).toContain('- implementation (array of string, required)');
    expect(prompt).not.toContain('End with the result block as before.');
    expect(blocks.steps.slice(0, 3)).toEqual(['rebase', 'implement', 'implement-improve']);
    expect((await runOf())?.currentStep).toBe('done');
    await assertInvariants(flow.app);
  });
});

describe('a server restart in the middle of the real implement step', () => {
  const RESTART_KEY = 'PROJ-432';
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  it('records the dead step after the restart, and the relaunch runs the real step on a block to done', async () => {
    const blocks = new BlockAgentRunner();
    flow = await createFlowHarness(RESTART_KEY, { blocks, realImplement: 'all' });
    await approvedRun(flow, RESTART_KEY, 'implement');
    // The process died while the step ran: the run is `running` with an attempt nobody owns.
    const dead = await flow.app.app.get(RunRepository).begin(RESTART_KEY, 'implement');
    expect(dead.activeAttempt).not.toBeNull();

    await flow.restart();
    for (let pass = 0; pass < 6; pass++) await flow.tick();
    await flow.app.pipeline.whenIdle(RESTART_KEY);

    const run = await flow.app.app.get(RunRepository).findRun(RESTART_KEY);
    const visits = await flow.app.app.get(VisitRepository).listStats(run!.id);
    // No person resumes: the server relaunches a step that a restart cut.
    expect(
      visits.filter((visit) => visit.step === 'implement').map((visit) => [visit.status, visit.killReason]),
    ).toEqual([
      ['failed', 'process died'],
      ['done', null],
    ]);
    expect(blocks.steps.filter((step) => step === 'implement')).toHaveLength(1);
    expect(run?.currentStep).toBe('done');
  });
});

describe('stop and resume with the real implement step', () => {
  const STOP_KEY = 'PROJ-433';
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  it('a stopped run takes no agent, and its resume runs the step on a block to done', async () => {
    const blocks = new BlockAgentRunner();
    flow = await createFlowHarness(STOP_KEY, { blocks, realImplement: 'all' });
    await approvedRun(flow, STOP_KEY, 'implement');

    await flow.app.app.get(CommandService).submit('stop', STOP_KEY, {});
    await flow.app.pipeline.whenIdle(STOP_KEY);
    expect(blocks.steps).toEqual([]);

    await flow.person('resume');

    expect((await flow.app.app.get(RunRepository).findRun(STOP_KEY))?.currentStep).toBe('done');
    expect(blocks.steps.filter((step) => step === 'implement')).toHaveLength(1);
  });
});

describe('the real code-review step in a whole flow', () => {
  const REVIEW_KEY = 'PROJ-434';
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  it('takes a review return back to implement and on to done', async () => {
    const blocks = new BlockAgentRunner({
      'code-review-quality': [
        {
          block: {
            decision: 'return',
            review: 'The parser drops an empty segment.',
            summary: ['the parser drops an empty segment'],
          },
        },
        {
          block: {
            decision: 'ok',
            review: 'The empty segment stays.',
            summary: ['the empty segment stays'],
            reason: 'The return is fixed.',
          },
        },
      ],
      'code-review-report': [
        {
          block: {
            whatChanged: 'The field parser changed.',
            codeReview: 'Quality returned the change.',
            whatToFix: '- keep the empty segment',
          },
        },
      ],
    });
    flow = await createFlowHarness(REVIEW_KEY, { blocks, realImplement: 'all', realReview: true });
    const documents = flow.app.app.get(DocumentRepository);
    const run = await approvedRun(flow, REVIEW_KEY, 'code-review');
    await documents.putDocument(run, 'implementation', '- changed the field parser\n');
    await documents.putDocument(
      run,
      'implementation_result',
      '{"implementation":["changed the field parser"],"summary":["why"]}\n',
    );

    await flow.person('resume');

    expect((await flow.app.app.get(RunRepository).findRun(REVIEW_KEY))?.currentStep).toBe('done');
    const steps = blocks.steps;
    const firstImplement = steps.indexOf('implement');
    expect(steps.slice(0, firstImplement).sort()).toEqual([
      'code-review-performance',
      'code-review-quality',
      'code-review-regressions',
      'code-review-report',
      'code-review-requirements',
      'code-review-security',
    ]);
    expect(steps.slice(firstImplement, firstImplement + 2)).toEqual(['implement', 'implement-improve']);
    expect(steps.filter((step) => step === 'code-review-quality').length).toBeGreaterThanOrEqual(2);
    const implementPrompt = blocks.prompts.find((launch) => launch.step === 'implement')?.prompt ?? '';
    expect(implementPrompt).toContain('keep the empty segment');
    expect(JSON.parse((await documents.latestBody(REVIEW_KEY, 'review_quality_result')) ?? '{}').decision).toBe('ok');
    await assertInvariants(flow.app);
  });
});
