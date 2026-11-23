import 'reflect-metadata';
import { RunStop } from '../agent/run-stop';
import type { AgentRunResult } from '../agent/agent-result';
import { ERROR_CODES } from '../contract/error-codes';
import { CODE_REVIEWERS } from '../contract/steps';
import { RunRepository } from '../history/run.repository';
import { storedState } from '../history/run-state';
import { VisitRepository } from '../history/visit.repository';
import { AgentDoor } from '../steps/shared/agent-door';
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
  function orderReviewers(beforeLater: () => void): void {
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
      beforeLater();
      return outside(start, request);
    });
  }

  async function review() {
    const run = await flow.begin('merge-request');
    run.currentStep = 'code-review';
    await flow.app.app.get(RunRepository).saveRun(run);
    return flow.app.pipeline.step('code-review', KEY);
  }

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  it('a person’s Stop during code-review starts no further reviewer and no report', async () => {
    await boot();
    orderReviewers(() => flow.app.app.get(RunStop).halt(KEY));

    await review();

    expect(blocks.steps).toEqual([FIRST]);
    const stats = await flow.app.app
      .get(VisitRepository)
      .listStats((await flow.app.app.get(RunRepository).findRun(KEY))!.id);
    expect(stats.map((stat) => stat.step)).not.toContain('code-review-report');
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
});
