import 'reflect-metadata';
import { storeRun } from '../store-run.spec-helpers';
import { ERROR_CODES } from '../../contract/error-codes';
import { REASON } from '../../contract/run-state';
import { CODE_REVIEWERS } from '../../contract/steps';
import { AgentCallRepository } from '../../history/agent-call.repository';
import { seedCall } from '../../history/agent-call.spec-helpers';
import { DocumentRepository } from '../../history/document.repository';
import { PlanChatStore } from '../../history/plan-chat.store';
import { RunRepository } from '../../history/run.repository';
import { storedState } from '../../history/run-state';
import { AgentDoor } from '../../steps/shared/agent-door';
import { createFlowHarness } from '../flow-harness';
import { BlockAgentRunner, type ScriptedAnswer } from '../result-answer';
import { assertSettled, settle } from './settle.spec-helpers';

const KEY = 'PROJ-904';
const FIRST = `code-review-${CODE_REVIEWERS[0]}`;
const REQUIREMENTS = `${JSON.stringify({
  prompt: 'Ship the field\n',
  plan: { name: 'plan', overview: '', items: ['ship the field'], decision: 'approve' },
})}\n`;
const block = (value: unknown): ScriptedAnswer => ({ block: value });
const returns = block({ decision: 'return', review: 'The parser drops the last row.', summary: ['one finding'] });
const nothing = block({ implementation: [], summary: ['nothing to change'] });

describe('a start refused at the door of an agent start inside the code-review step', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  async function boot(blocks: BlockAgentRunner, env: Record<string, string> = {}): Promise<void> {
    flow = await createFlowHarness(KEY, { blocks, realImplement: 'all', realReview: true, realHost: true, env });
    flow.fastWaits();
  }

  async function atReview(requirements = false): Promise<void> {
    const run = await flow.begin('merge-request');
    run.currentStep = 'code-review';
    if (requirements) await flow.app.app.get(DocumentRepository).putDocument(run, 'requirements', REQUIREMENTS);
    await storeRun(flow.app.app.get(RunRepository), run);
  }

  /**
   * The first reviewer reaches the real door at once. Every later one reaches it only after the first has ended and its
   * spend is on the run; `beforeLater` is what happens in between. Each start still passes the door as it is.
   */
  function orderReviewers(beforeLater: () => Promise<void>): void {
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

  const find = async () => (await flow.app.app.get(RunRepository).findRun(KEY))!;

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  it('a reviewer refused for the same input starts no review again, and the run waits with its question', async () => {
    const blocks = new BlockAgentRunner({
      'code-review-quality': [returns, returns],
      implement: [nothing, nothing],
    });
    await boot(blocks);
    await atReview(true);

    const ended = await flow.app.pipeline.runThrough(KEY, { auto: true });
    await settle(flow.app);

    expect(ended.message).toContain('Not started again: same input as visit 1');
    expect(blocks.steps.filter((step) => step === 'code-review-quality')).toHaveLength(1);
    expect((await find()).status).toBe('waiting');
    const asked = (await flow.app.app.get(PlanChatStore).read(KEY)).entries.filter(
      (entry) => entry.kind === 'question',
    );
    expect(asked).toHaveLength(1);
    await assertSettled(flow.app);
  });

  it('a limit reached between two reviewers does not cut a round the machine started, and the next start is blocked on the limit', async () => {
    const spend = new BlockAgentRunner();
    await boot(spend, { MAX_RUN_USD: '1' });
    await atReview();
    orderReviewers(async () => {
      await seedCall(flow.app.app.get(AgentCallRepository), { runKey: KEY, step: FIRST, usd: 2 });
    });

    await flow.app.pipeline.step('code-review', KEY, { auto: true, startBy: 'machine' });
    await settle(flow.app);

    expect([...spend.steps].sort()).toEqual(
      [...CODE_REVIEWERS.map((name) => `code-review-${name}`), 'code-review-report'].sort(),
    );
    const next = await flow.app.app.get(AgentDoor).admitStep(KEY, 'commit', { auto: true, startBy: 'machine' }, true);
    expect(next.kind).toBe('blocked');
    expect((await find()).status).toBe('blocked');
    expect(storedState(await find()).reason?.code).toBe(ERROR_CODES.SPEND_LIMIT);
    await assertSettled(flow.app);
  });

  it('a Stop between two reviewers starts no further reviewer, and the run is stopped with Resume', async () => {
    const stopping = new BlockAgentRunner();
    await boot(stopping);
    await atReview();
    /** The Stop as another process or the CLI stores it: the run's state only. */
    orderReviewers(async () => {
      const runs = flow.app.app.get(RunRepository);
      await runs.release((await runs.findRun(KEY))!, {
        status: 'blocked',
        reason: { code: REASON.stopped, message: 'Stopped.' },
      });
    });

    await flow.app.pipeline.step('code-review', KEY, { auto: true, startBy: 'machine' });
    await settle(flow.app);

    expect(stopping.steps).toEqual([FIRST]);
    expect(storedState(await find()).state).toBe('stopped');
    await assertSettled(flow.app);
  });
});
