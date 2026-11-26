import 'reflect-metadata';
import { RunQueriesService } from '../../api/run-queries.service';
import { RunCommandsService } from '../../api/run-commands.service';
import { REASON, STOP_NOTE } from '../../contract/run-state';
import { RunRepository } from '../../history/run.repository';
import { storedState, writeRunState } from '../../history/run-state';
import { createFlowHarness } from '../flow-harness';
import { storeRun } from '../store-run.spec-helpers';
import { epicMerges } from './epic-merge.spec-helpers';
import { assertSettled, settle } from './settle.spec-helpers';

const KEY = 'PROJ-910';
const PARTS = ['a', 'b', 'c'];

describe('a person’s Stop of an epic while its subtasks run', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  beforeEach(async () => {
    flow = await createFlowHarness(KEY);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  const runs = () => flow.app.app.get(RunRepository);
  const epic = epicMerges(() => flow, KEY);
  const commands = () => flow.app.app.get(RunCommandsService);
  const state = async (key: string) => storedState((await runs().findRun(key))!);
  const actions = async (key: string) => (await flow.app.app.get(RunQueriesService).flow(key)).actions;

  /** The real split parent has started its parts; two of them work and one has not started. */
  async function runningEpic(): Promise<void> {
    await epic.seed(PARTS);
    for (const id of ['a', 'b']) {
      const part = (await runs().findRun(`${KEY}-${id}`))!;
      part.activeAttempt = `attempt-${id}`;
      writeRunState(part, { status: 'running', currentStep: 'implement' });
      await storeRun(runs(), part);
    }
  }

  it('leaves the epic and each part stopped with Resume, and Resume takes them on again', async () => {
    await runningEpic();

    await commands().stop(KEY);
    await settle(flow.app);

    for (const key of [KEY, `${KEY}-a`, `${KEY}-b`]) {
      expect((await state(key)).state).toBe('stopped');
      expect((await state(key)).reason?.code).toBe(REASON.stopped);
      expect((await state(key)).reason?.message).toBe(STOP_NOTE);
      expect(await actions(key)).toContain('resume');
    }
    expect((await state(`${KEY}-c`)).state).toBe('idle');
    await assertSettled(flow.app);

    await commands().resume(KEY);
    await flow.app.pipeline.whenIdle(KEY);
    await flow.tick();
    await settle(flow.app);

    // The parts the Stop stopped start again; the part that had not started was never stopped, so it is not started twice.
    expect((await state(KEY)).state).not.toBe('stopped');
    expect(flow.launched.slice(PARTS.length)).toEqual([`${KEY}-a`, `${KEY}-b`]);
    await assertSettled(flow.app);
  });
});
