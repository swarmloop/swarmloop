import 'reflect-metadata';
import { CommandRepository } from '../../history/command.repository';
import { RunRepository } from '../../history/run.repository';
import { ERROR_CODES } from '../../contract/error-codes';
import { writeRunState } from '../../history/run-state';
import { RunRebase } from '../../steps/run-rebase';
import { createFlowHarness } from '../flow-harness';
import { storeRun } from '../store-run.spec-helpers';
import { epicMerges } from './epic-merge.spec-helpers';
import { epicWithTwoParts, landOnMain, restartThenRecover, takenByDeadProcess } from './epic-main.spec-helpers';
import { assertSettled, settle } from './settle.spec-helpers';

const KEY = 'PROJ-915';

describe('a server restart during a rebase in an epic', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  const epic = epicMerges(() => flow, KEY);
  const runs = () => flow.app.app.get(RunRepository);

  beforeEach(async () => {
    flow = await createFlowHarness(KEY, { realHost: true, taskWorktrees: true });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  const rebasesOf = async (id: string) => {
    const part = (await runs().findRun(`${KEY}-${id}`))!;
    return (await flow.app.app.get(CommandRepository).listForRun(part.id)).filter(
      (command) => command.type === 'rebase',
    );
  };

  async function restart(): Promise<void> {
    await restartThenRecover(flow);
    await settle(flow.app);
    await flow.tick();
    await settle(flow.app);
  }

  it('during the rebase of a part: the next process runs that Rebase again and the part is moved once', async () => {
    await epicWithTwoParts(flow, epic, KEY);
    // Main moved on and the epic took it, so the part has a new tip to move onto.
    landOnMain(flow);
    await flow.app.app.get(RunRebase).rebase(KEY, false, false, true);
    // The epic waits for its parts again; the service that moves the parts is not under test here.
    const parent = (await runs().findRun(KEY))!;
    writeRunState(parent, {
      status: 'waiting',
      currentStep: 'implement',
      reason: { code: ERROR_CODES.SUBTASKS_RUNNING, message: 'subtasks run' },
    });
    await storeRun(runs(), parent);
    const tip = await flow.app.app.get(RunRebase).tipOf(KEY);
    const key = `subtask-rebase-${KEY}-a-${tip}`;
    // The process took the part's Rebase, moved its worktree and died before the command ended.
    await takenByDeadProcess(flow, `${KEY}-a`, 'rebase', { byParent: true }, key);
    await flow.app.app.get(RunRebase).rebase(`${KEY}-a`, false, true);

    await restart();

    const moves = (await rebasesOf('a')).filter((command) => command.idempotencyKey === key);
    expect(moves.map((command) => command.state)).toEqual(['succeeded']);
    await assertSettled(flow.app);
  });

  it("during a person's Rebase of the epic, after its branch was pushed: each open part is moved once onto the new tip", async () => {
    await epicWithTwoParts(flow, epic, KEY);
    await takenByDeadProcess(flow, KEY, 'rebase', {}, `person-rebase-${KEY}`);
    await flow.app.app.get(RunRebase).rebase(KEY);
    const tip = await flow.app.app.get(RunRebase).tipOf(KEY);

    await restart();

    for (const id of ['a', 'b']) {
      const moves = (await rebasesOf(id)).filter(
        (command) => command.idempotencyKey === `subtask-rebase-${KEY}-${id}-${tip}`,
      );
      expect(moves.map((command) => command.state)).toEqual(['succeeded']);
    }
    await assertSettled(flow.app);
  });
});
