import 'reflect-metadata';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { ERROR_CODES } from '../../contract/error-codes';
import { CommandRepository } from '../../history/command.repository';
import { RunRepository } from '../../history/run.repository';
import { DocumentRepository } from '../../history/document.repository';
import { storedState, writeRunState } from '../../history/run-state';
import { REBASE_JOURNAL, parseJournal } from '../../git/rebase';
import { RunRebase } from '../../steps/run-rebase';
import { BaseTips } from '../../steps/shared/base-tips';
import { SubtaskOps } from '../../steps/shared/subtask-ops';
import { storeRun } from '../store-run.spec-helpers';
import { createFlowHarness } from '../flow-harness';
import { BlockAgentRunner } from '../result-answer';
import { git } from '../runs.spec-helpers';
import { epicMerges } from './epic-merge.spec-helpers';
import { epicWithTwoParts, landOnMain, restartThenRecover, takenByDeadProcess } from './epic-main.spec-helpers';
import { assertSettled, settle } from './settle.spec-helpers';

const KEY = 'PROJ-914';

type Flow = Awaited<ReturnType<typeof createFlowHarness>>;

/** Where the cut main move stood: finished, cut after its base tips were recorded, or parked on a squash conflict. */
type Cut = 'clean' | 'recorded-not-completed' | 'parked-squash';

describe('a server restart during an epic main move, after its branch was pushed and before its subtasks moved', () => {
  let flow: Flow;
  const epic = epicMerges(() => flow, KEY);
  const runs = () => flow.app.app.get(RunRepository);
  const documents = () => flow.app.app.get(DocumentRepository);

  beforeEach(async () => {
    flow = await createFlowHarness(KEY, {
      realHost: true,
      taskWorktrees: true,
      realReview: true,
      blocks: new BlockAgentRunner({}),
    });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  /** The epic with its two parts and a green main that moved on. */
  async function epicWithMainMoved(): Promise<{ payload: { main: string } }> {
    await epicWithTwoParts(flow, epic, KEY);
    return { payload: { main: `demo at ${landOnMain(flow)}` } };
  }

  /** The epic's own commit that changes the file main changed too, so that its move parks a conflict. */
  function conflictingOwnCommit(): void {
    writeFileSync(join(flow.tree, 'src/fix.ts'), 'export const fix = 2;\n');
    git(flow.tree, ['add', 'src/fix.ts']);
    git(flow.tree, ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', 'commit', '-m', 'feat: own fix']);
  }

  /** The main move's command a process took, executing; then the epic's own rebase, cut where `cut` says. */
  async function cutDuringMove(payload: { main: string }, cut: Cut): Promise<void> {
    await takenByDeadProcess(flow, KEY, 'rebase', payload, `epic-main-${KEY}-${payload.main}`);
    if (cut === 'parked-squash') conflictingOwnCommit();
    const recorded = jest.spyOn(BaseTips.prototype, 'recordMoved');
    if (cut === 'recorded-not-completed') {
      recorded.mockImplementation(async function (this: BaseTips, ...args) {
        // The spy gives way to the real method for this one call, which records the tips and then dies.
        recorded.mockRestore();
        await this.recordMoved(...args);
        throw new Error('the process died');
      });
    }
    await flow.app.app
      .get(RunRebase)
      .rebase(KEY, false, false, true)
      .catch(() => undefined);
    recorded.mockRestore();
    if (cut !== 'parked-squash') return;
    // The conflict was parked by a move that measured the run's change from git's merge base: an entry with no `ownBase`.
    const stored = parseJournal(await documents().latestBody(KEY, REBASE_JOURNAL));
    for (const entry of Object.values(stored)) delete entry.ownBase;
    await documents().putDocument((await runs().findRun(KEY))!, REBASE_JOURNAL, JSON.stringify(stored));
  }

  /** Exactly one rebase command moved the part onto a tip of the epic for the main move, and it ended well. */
  async function expectMovedOnce(id: string): Promise<void> {
    const part = (await runs().findRun(`${KEY}-${id}`))!;
    // A later pass that merges a sibling into the epic branch moves the part for that merge, under the key of that commit alone.
    const moves = (await flow.app.app.get(CommandRepository).listForRun(part.id)).filter(
      (command) => command.type === 'rebase' && command.idempotencyKey?.startsWith(`subtask-rebase-${part.key}-demo@`),
    );
    expect(moves.map((command) => command.state)).toEqual(['succeeded']);
  }

  async function finishAfterRestart(): Promise<void> {
    await restartThenRecover(flow);
    await settle(flow.app);
    await flow.tick();
    await settle(flow.app);
  }

  it.each<[string, Cut]>([
    ['a clean move through RunRebaseService', 'clean'],
    ['a move cut after BaseTips.recordMoved and before completeRebase', 'recorded-not-completed'],
  ])('%s: the next process finishes the move and each open part moves once', async (_name, cut) => {
    const { payload } = await epicWithMainMoved();
    await cutDuringMove(payload, cut);
    await finishAfterRestart();

    await expectMovedOnce('a');
    await expectMovedOnce('b');
    expect(storedState((await runs().findRun(`${KEY}-b`))!).reason?.code).toBe(ERROR_CODES.SUBTASK_WAITING);
    await assertSettled(flow.app);
  });

  it('a retaken squash conflict: the next process retakes it, finishes the move and each open part moves once', async () => {
    const { payload } = await epicWithMainMoved();
    await cutDuringMove(payload, 'parked-squash');

    await finishAfterRestart();

    await expectMovedOnce('a');
    await expectMovedOnce('b');
    expect(storedState((await runs().findRun(`${KEY}-b`))!).reason?.code).toBe(ERROR_CODES.SUBTASK_WAITING);
    await assertSettled(flow.app);
  });

  it('a move after a resolved conflict: the next process re-enters the round and each open part moves once', async () => {
    const { payload } = await epicWithMainMoved();
    const commands = flow.app.app.get(CommandRepository);
    const { command } = await commands.accept({
      type: 'rebase',
      key: KEY,
      payload,
      idempotencyKey: `epic-main-${KEY}-${payload.main}`,
      admit: () => undefined,
    });
    await commands.start(command.id);
    await commands.finish(command.id, 'succeeded', { value: null });
    // The round passed its review, committed the epic's branch and died before any task moved.
    const parent = (await runs().findRun(KEY))!;
    await documents().putDocument(parent, 'epic_round', 'open\n');
    await documents().putDocument(parent, 'implementation', '- the epic\n');
    writeRunState(parent, { status: 'waiting', currentStep: 'code-review' });
    await storeRun(runs(), parent);
    await documents().putDocument(parent, 'requirement_list', '[{"id":"R1","text":"ship the field"}]\n');
    await flow.app.app.get(SubtaskOps).commitOwnEdits((await runs().findRun(KEY))!, true);
    await restartThenRecover(flow);
    await flow.app.pipeline.runThrough(KEY, { auto: true });
    await settle(flow.app);

    await expectMovedOnce('a');
    await expectMovedOnce('b');
    expect(storedState((await runs().findRun(`${KEY}-b`))!).reason?.code).toBe(ERROR_CODES.SUBTASK_WAITING);
    await assertSettled(flow.app);
  });
});
