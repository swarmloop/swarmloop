import 'reflect-metadata';
import { RunQueriesService } from '../../api/run-queries.service';
import { RunRebaseService } from '../../api/run-rebase.service';
import { ERROR_CODES } from '../../contract/error-codes';
import { etaPhase } from '../../contract/eta';
import { parseSubtasks } from '../../contract/subtask';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { storedState, writeRunState } from '../../history/run-state';
import { CommandService } from '../../pipeline/command.service';
import { SubtaskOps } from '../../steps/shared/subtask-ops';
import { createFlowHarness } from '../flow-harness';
import { storeRun } from '../store-run.spec-helpers';
import { epicMerges } from './epic-merge.spec-helpers';
import { assertSettled, settle } from './settle.spec-helpers';

const KEY = 'PROJ-911';

describe('an epic whose subtask is blocked while its siblings go on', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  beforeEach(async () => {
    flow = await createFlowHarness(KEY);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  const runs = () => flow.app.app.get(RunRepository);
  const documents = () => flow.app.app.get(DocumentRepository);
  const epic = epicMerges(() => flow, KEY);
  const state = async (key: string) => storedState((await runs().findRun(key))!);
  const statuses = async () =>
    Object.fromEntries(
      parseSubtasks(await documents().latestBody(KEY, 'subtasks')).map((item) => [item.id, item.status]),
    );

  async function setPart(id: string, status: string, reason?: { code: string; message: string }): Promise<void> {
    const part = (await runs().findRun(`${KEY}-${id}`))!;
    writeRunState(part, { status, currentStep: 'implement', ...(reason ? { reason } : {}) });
    await storeRun(runs(), part);
  }

  it('shows the blocked part by name, keeps the siblings going and the epic waiting', async () => {
    await epic.seed(['a', 'b', 'c']);
    await setPart('a', 'blocked', { code: ERROR_CODES.CHECK_FAILED, message: 'a check failed' });

    await flow.app.pipeline.step('implement', KEY);
    await settle(flow.app);

    expect(await statuses()).toEqual({ a: 'blocked', b: 'running', c: 'running' });
    const parent = await state(KEY);
    expect(parent.state).toBe('waiting');
    expect(parent.reason?.code).toBe(ERROR_CODES.SUBTASKS_RUNNING);
    expect(parent.reason?.message).toContain('subtask a is blocked');
    expect((await flow.app.app.get(RunQueriesService).flow(`${KEY}-a`)).state).toBe('blocked');
    await assertSettled(flow.app);
  });

  describe('when the round that ended sent its parts their move onto the new tip', () => {
    /** The part is blocked with `code` and takes an event move, which runs only when `held` ends. */
    async function sendMove(code: string): Promise<{ end: (outcome: object) => Promise<void> }> {
      await epic.seed(['a']);
      await setPart('a', 'blocked', { code, message: 'the part is blocked' });
      const part = (await runs().findRun(`${KEY}-a`))!;
      await documents().putDocument(part, 'repos', 'demo\n');
      let finish!: (outcome: object) => void;
      const held = new Promise((resolve, reject) => {
        finish = (outcome) => (outcome instanceof Error ? reject(outcome) : resolve(outcome));
      });
      jest.spyOn(flow.app.app.get(RunRebaseService), 'rebase').mockImplementation(() => held as never);
      expect(
        await flow.app.app.get(SubtaskOps).rebase(part, { tip: 'demo@moved', note: 'rebased onto the epic' }),
      ).toBe(true);
      return {
        end: async (outcome) => {
          finish(outcome);
          await held.catch(() => undefined);
        },
      };
    }

    it('waits for a check-blocked part while its move has not run', async () => {
      const move = await sendMove(ERROR_CODES.CHECK_FAILED);

      await flow.app.pipeline.step('implement', KEY);

      const parent = await state(KEY);
      expect(parent.state).toBe('waiting');
      expect(parent.reason?.code).toBe(ERROR_CODES.SUBTASKS_RUNNING);
      expect(await statuses()).toEqual({ a: 'running' });
      expect(parseSubtasks(await documents().latestBody(KEY, 'subtasks'))[0].note).toBe(
        "moving onto the epic's new tip",
      );
      expect(etaPhase(parent.state, parent.reason)).toBe('working');
      await move.end({ key: `${KEY}-a`, status: 'blocked' });
      await flow.app.app.get(CommandService).idle();
    });

    it('blocks with the reason of a move that failed', async () => {
      const move = await sendMove(ERROR_CODES.CHECK_FAILED);
      await flow.app.pipeline.step('implement', KEY);

      await move.end(new Error('push refused by the host'));
      await settle(flow.app);

      const parent = await state(KEY);
      expect(parent.state).toBe('blocked');
      expect(parent.reason?.code).toBe(ERROR_CODES.SUBTASK_BLOCKED);
      expect(parent.reason?.message).toContain('push refused by the host');
      await assertSettled(flow.app);
    });

    it('blocks for a part that its move leaves blocked, as it does without a move', async () => {
      const move = await sendMove(ERROR_CODES.STEP_FAILED);
      await flow.app.pipeline.step('implement', KEY);

      await move.end({ key: `${KEY}-a`, status: 'blocked' });
      await settle(flow.app);

      const parent = await state(KEY);
      expect(parent.state).toBe('blocked');
      expect(parent.reason?.code).toBe(ERROR_CODES.SUBTASK_BLOCKED);
      expect(parent.reason?.message).toContain('subtask a is blocked');
      await assertSettled(flow.app);
    });
  });
});
