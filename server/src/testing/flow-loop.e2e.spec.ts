import 'reflect-metadata';
import { storeRun } from './store-run.spec-helpers';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { RunQueriesService } from '../api/run-queries.service';
import { ERROR_CODES } from '../contract/error-codes';
import { REASON } from '../contract/run-state';
import { DocumentRepository } from '../history/document.repository';
import { StepStatEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { VisitRepository } from '../history/visit.repository';
import { storedState, writeRunState } from '../history/run-state';
import { VisitStartRepository } from '../history/visit-start.repository';
import { CommandService } from '../pipeline/command.service';
import { PERSON_RESUME } from '../pipeline/resume-sender';
import { StartGate } from '../pipeline/start-gate';
import { SubtaskPort } from '../pipeline/subtask-port';
import { readVisitInput } from '../steps/shared/visit-input';
import { epicLoop, LOOP_WORDS } from './epic-loop.spec-helpers';
import { createFlowHarness } from './flow-harness';
import { assertInvariants } from './flow-invariants';

const KEY = 'PROJ-480';
const TASK = `${KEY}-a`;
const DECISION = 'Keep the policy in b.';

/** The 21.11 loop: a subtask asks a decision as a need on a sibling that is already merged, and its agent writes the same need on every visit. */
describe('a subtask that keeps writing the same need on a merged sibling', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let visits: () => number;
  let loop: ReturnType<typeof epicLoop>;

  beforeEach(async () => {
    flow = await createFlowHarness(KEY);
    loop = epicLoop(flow, KEY);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  const runs = () => flow.app.app.get(RunRepository);
  const documents = () => flow.app.app.get(DocumentRepository);
  const child = async () => (await runs().findRun(TASK))!;
  const view = () => flow.app.app.get(RunQueriesService).flow(KEY);

  const starts = async () =>
    (await flow.app.app.get(VisitStartRepository).forRun((await child()).id)).map((row) => row);

  it('starts the task once on each input, asks the epic planner once, and ends with the question at the person', async () => {
    await loop.seed();
    visits = loop.fakeAgent();
    const askAbout = jest.spyOn(flow.app.app.get(SubtaskPort), 'askAbout').mockResolvedValue(DECISION);

    await flow.app.app.get(CommandService).submit('resume', TASK, { ...PERSON_RESUME });
    await loop.settle();
    await flow.app.pipeline.step('implement', KEY);
    await loop.settle();
    await flow.app.pipeline.step('implement', KEY);
    await loop.settle();

    expect(askAbout).toHaveBeenCalledTimes(1);
    const rows = await starts();
    expect(rows.map((row) => [row.startedBy, row.level])).toEqual([
      ['person', null],
      ['planner', 1],
    ]);
    expect(new Set(rows.map((row) => row.inputDigest)).size).toBe(rows.length);
    expect(visits()).toBe(2);
    const asked = await view();
    expect(asked.items).toHaveLength(1);
    expect(asked.items[0].label.startsWith('Subtask a asks:')).toBe(true);
    expect(asked.stateReason?.code).toBe('NEEDS_ANSWERS');
    await assertInvariants(flow.app);
  });

  it('does not start the task again on the input of its last visit, shows why, and puts the last words to the person', async () => {
    await loop.seed();
    visits = loop.fakeAgent();
    jest.spyOn(flow.app.app.get(SubtaskPort), 'askAbout').mockResolvedValue(null);
    await flow.app.app.get(CommandService).submit('resume', TASK, { ...PERSON_RESUME });
    await loop.settle();
    const before = visits();
    const run = await child();
    const shown: (string | undefined)[] = [];
    const port = flow.app.app.get(SubtaskPort);
    const askUp = port.askUp.bind(port);
    jest.spyOn(port, 'askUp').mockImplementation(async (asking, question, level) => {
      shown.push(storedState((await runs().findRun(asking.key))!).reason?.message);
      return askUp(asking, question, level);
    });

    await flow.app.app.get(StartGate).resume(run, { by: 'machine', event: 'port-wake' });
    await loop.settle();

    expect(visits()).toBe(before);
    expect(shown[0]).toBe('Not started again: same input as visit 1; asked the planner of this run');
    const asked = await view();
    const head = 'Subtask a asks: Not started again: same input as visit 1; asked the person who started the run.';
    expect(asked.items.map((item) => item.label.startsWith(head))).toContain(true);
    expect(asked.items.find((item) => item.label.startsWith(head))?.label).toContain(LOOP_WORDS);
    expect(storedState(await child()).reason?.code).not.toBe(REASON.stopped);
    await assertInvariants(flow.app);
  });

  it("runs the epic's split pass when the machine wakes it blocked SUBTASK_BLOCKED, with no refusal and no question", async () => {
    await loop.seed();
    visits = loop.fakeAgent();
    const parent = (await runs().findRun(KEY))!;
    const worktrees = join(flow.app.root, 'worktrees', KEY);
    mkdirSync(worktrees, { recursive: true });
    // The epic's last visit ended on the input it has now: an agent step would be refused as the same input.
    const digest = await readVisitInput({ documents: documents(), worktrees }, parent, 'implement', '');
    const now = new Date().toISOString();
    await flow.app.app.get(VisitStartRepository).note({
      runId: parent.id,
      step: 'implement',
      attemptId: 'epic-1',
      startedBy: 'machine',
      level: null,
      inputDigest: digest,
      startReason: null,
      rerunUnfinished: false,
      createdAt: now,
    });
    await flow.app.app.get(VisitRepository).saveStat(
      Object.assign(new StepStatEntity(), {
        runId: parent.id,
        step: 'implement',
        attempt: 1,
        attemptId: 'epic-1',
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        status: 'waiting',
      }),
    );
    writeRunState(parent, {
      status: 'blocked',
      currentStep: 'implement',
      reason: { code: ERROR_CODES.SUBTASK_BLOCKED, message: 'a task is blocked' },
    });
    await storeRun(runs(), parent);

    const seen = await flow.app.app.get(StartGate).admit(KEY, 'implement', { startBy: 'machine' });

    expect(seen).toMatchObject({ kind: 'admitted', start: { agent: false } });
    expect(storedState((await runs().findRun(KEY))!).reason?.code).not.toBe(REASON.sameInput);
    await assertInvariants(flow.app);
  });
});
