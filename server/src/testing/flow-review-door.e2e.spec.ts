import 'reflect-metadata';
import type { AgentRunResult } from '../agent/agent-result';
import { ERROR_CODES } from '../contract/error-codes';
import { REASON } from '../contract/run-state';
import { CODE_REVIEWERS } from '../contract/steps';
import { RunRepository } from '../history/run.repository';
import { storedState } from '../history/run-state';
import { Reconciler } from '../pipeline/reconciler';
import { CommandService } from '../pipeline/command.service';
import { HOST_RETRY_MS } from '../integrations/http';
import { AgentDoor } from '../steps/shared/agent-door';
import type { StepOptions } from '../core/pipeline-result';
import { createFlowHarness } from './flow-harness';
import { BlockAgentRunner } from './result-answer';

const KEY = 'PROJ-521';
const FIRST = `code-review-${CODE_REVIEWERS[0]}`;

/** Every launch costs two dollars, so one reviewer takes a run past a limit of one. */
class CostlyRunner extends BlockAgentRunner {
  override async run(input: Parameters<BlockAgentRunner['run']>[0]): Promise<AgentRunResult> {
    return { ...(await super.run(input)), usd: 2 };
  }
}

/** The first reviewer's first launch ends with the model host's API error, at the fake clock's now. */
class DownRunner extends BlockAgentRunner {
  constructor(
    private readonly now: () => number,
    others: ConstructorParameters<typeof BlockAgentRunner>[0] = {},
  ) {
    super({ ...others, [FIRST]: [{ outage: { host: 'api.anthropic.com', detail: 'API Error: 502' } }] });
  }

  override async run(input: Parameters<BlockAgentRunner['run']>[0]): Promise<AgentRunResult> {
    const result = await super.run(input);
    return result.outage ? { ...result, finishedAt: new Date(this.now()).toISOString() } : result;
  }
}

describe('a reviewer or the report starts only through the door', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let blocks: BlockAgentRunner;

  async function boot(env: Record<string, string> = {}, runner: BlockAgentRunner = new BlockAgentRunner()) {
    blocks = runner;
    flow = await createFlowHarness(KEY, {
      blocks,
      realImplement: 'all',
      realReview: true,
      realHost: true,
      env,
    });
    flow.fastWaits();
  }

  /**
   * The first reviewer reaches the door at once. Every later one reaches it only after the first has ended and its
   * spend is on the run, and `beforeLater` is what happens in between.
   */
  function orderReviewers(beforeLater: () => Promise<void> | void): void {
    const door = flow.app.app.get(AgentDoor);
    const outside = door.outside.bind(door);
    let ended!: () => void;
    const firstEnded = new Promise<void>((resolve) => (ended = resolve));
    jest.spyOn(door, 'outside').mockImplementation(async (start, request) => {
      if (start.step === FIRST) {
        try {
          return await outside(start, request);
        } finally {
          ended();
        }
      }
      await firstEnded;
      await beforeLater();
      return outside(start, request);
    });
  }

  async function review(options: StepOptions = {}) {
    const run = await flow.begin('merge-request');
    run.currentStep = 'code-review';
    await flow.app.app.get(RunRepository).saveRun(run);
    return flow.app.pipeline.step('code-review', KEY, options);
  }

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  it('a person’s Stop during code-review starts no further reviewer and no report', async () => {
    await boot();
    /** The Stop as another server process or the CLI stores it: only the run's state, with no RunStop.halt here. */
    orderReviewers(async () => {
      const runs = flow.app.app.get(RunRepository);
      await runs.release((await runs.findRun(KEY))!, {
        status: 'blocked',
        reason: { code: REASON.stopped, message: 'Stopped.' },
      });
    });

    await review({ auto: true, startBy: 'machine' });

    expect(blocks.steps).toEqual([FIRST]);
  });

  it('a limit reached between two reviewers starts no further reviewer', async () => {
    await boot({ MAX_RUN_USD: '1' }, new CostlyRunner());
    orderReviewers(() => undefined);

    await review();

    expect(blocks.steps).toEqual([FIRST]);
    const run = (await flow.app.app.get(RunRepository).findRun(KEY))!;
    expect(run.status).toBe('blocked');
    expect(storedState(run).reason?.code).toBe(ERROR_CODES.SPEND_LIMIT);
  });

  it('a limit reached before the report starts no report and blocks the run on the limit', async () => {
    await boot({ MAX_RUN_USD: '1' });
    const door = flow.app.app.get(AgentDoor);
    const outside = door.outside.bind(door);
    jest.spyOn(door, 'outside').mockImplementation(async (start, request) => {
      if (start.step === 'code-review-report') request.run.spentUsd = 2;
      return outside(start, request);
    });

    await review();

    expect(blocks.steps).not.toContain('code-review-report');
    expect(blocks.steps).toHaveLength(CODE_REVIEWERS.length);
    const run = (await flow.app.app.get(RunRepository).findRun(KEY))!;
    expect(run.status).toBe('blocked');
    expect(storedState(run).reason?.code).toBe(ERROR_CODES.SPEND_LIMIT);
  });

  it('a reviewer whose model host did not answer makes the run wait with its next try, and the round goes on at the next try through the door', async () => {
    await boot({}, new DownRunner(() => flow.app.clock.now()));
    const first = flow.app.clock.now();

    const waited = await review({ auto: true, startBy: 'machine' });
    const waiting = (await flow.app.app.get(RunRepository).findRun(KEY))!;
    const reason = storedState(waiting).reason;

    expect(waited.exitCode).not.toBe(1);
    expect(waiting.status).toBe('waiting');
    expect(reason?.code).toBe(ERROR_CODES.HOST_UNAVAILABLE);
    expect(reason?.retryAt).toBe(new Date(first + HOST_RETRY_MS).toISOString());
    expect(blocks.steps.filter((step) => step === FIRST)).toHaveLength(1);

    const accept = jest.spyOn(flow.app.app.get(CommandService), 'accept').mockResolvedValue({} as never);
    const resumes = flow.app.app.get(Reconciler);
    await resumes.resumeHostUnavailable();
    expect(accept).not.toHaveBeenCalled();
    flow.app.clock.advance(HOST_RETRY_MS);
    await resumes.resumeHostUnavailable();
    expect(accept).toHaveBeenCalledWith('resume', KEY, { by: 'machine', level: null }, expect.anything());

    const done = await flow.app.pipeline.step('code-review', KEY, { auto: true, startBy: 'machine' });

    expect(done.exitCode).toBe(0);
    expect(blocks.steps.filter((step) => step === FIRST)).toHaveLength(2);
    expect(blocks.steps.filter((step) => step === 'code-review-report')).toHaveLength(1);
    expect((await flow.app.app.get(RunRepository).findRun(KEY))!.status).not.toBe('blocked');
  });

  it('keeps the answer of a reviewer that returned while another one’s model host did not answer', async () => {
    const other = `code-review-${CODE_REVIEWERS[1]}`;
    const returned = { decision: 'return', review: 'needs work', summary: ['needs work'] };
    await boot({}, new DownRunner(() => flow.app.clock.now(), { [other]: [{ block: returned }] }));

    await review({ auto: true, startBy: 'machine' });
    expect(storedState((await flow.app.app.get(RunRepository).findRun(KEY))!).reason?.code).toBe(
      ERROR_CODES.HOST_UNAVAILABLE,
    );

    flow.app.clock.advance(HOST_RETRY_MS);
    await flow.app.pipeline.step('code-review', KEY, { auto: true, startBy: 'machine' });

    expect(blocks.steps.filter((step) => step === other)).toHaveLength(1);
    expect(blocks.steps.filter((step) => step === 'code-review-report')).toHaveLength(1);
  });
});
