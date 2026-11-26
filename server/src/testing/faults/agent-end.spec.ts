import 'reflect-metadata';
import { RunQueriesService } from '../../api/run-queries.service';
import { REASON } from '../../contract/run-state';
import { RunRepository } from '../../history/run.repository';
import { VisitRepository } from '../../history/visit.repository';
import { storedState } from '../../history/run-state';
import { CommandService } from '../../pipeline/command.service';
import { PERSON_RESUME } from '../../pipeline/resume-sender';
import { RunStop } from '../../agent/run-stop';
import { createFlowHarness } from '../flow-harness';
import { approvedRun } from '../implement-flow.spec-helpers';
import { BlockAgentRunner } from '../result-answer';
import { assertSettled, settle } from './settle.spec-helpers';

const KEY = 'PROJ-1';
/** The time limit of an agent launch, as the shipped settings give it. */
const TIME_LIMIT_MS = 60 * 60_000;

type Launch = Awaited<ReturnType<BlockAgentRunner['run']>>;

/** An agent whose implement launch ends the way `end` says; every other launch answers as the blocks do. */
class EndingAgent extends BlockAgentRunner {
  private readonly reachedLaunch: Promise<void>;
  private reach: () => void = () => undefined;

  constructor(private readonly end: (answered: Launch) => Promise<Launch>) {
    super();
    this.reachedLaunch = new Promise((reached) => {
      this.reach = reached;
    });
  }

  /** Settles once the implement launch has started. */
  launched(): Promise<void> {
    return this.reachedLaunch;
  }

  override async run(input: Parameters<BlockAgentRunner['run']>[0]): Promise<Launch> {
    const answered = await super.run(input);
    if (input.step !== 'implement') return answered;
    this.reach();
    return this.end(answered);
  }
}

describe('an agent that ends before its answer', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let agent: EndingAgent;

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  async function start(end: (answered: Launch) => Promise<Launch>): Promise<void> {
    agent = new EndingAgent(end);
    flow = await createFlowHarness(KEY, { blocks: agent });
    await approvedRun(flow, KEY, 'implement');
  }

  const resume = () => flow.app.app.get(CommandService).submit('resume', KEY, { ...PERSON_RESUME });
  const stored = async () => storedState((await flow.app.app.get(RunRepository).findRun(KEY))!);

  // c04's table of outside waits (contract/outside-waits.ts) has no rule for a signal-ended agent, so whether such a
  // signal settles waiting by itself is c04's class and is not patched here. This case holds what must hold either
  // way: the step is not lost, the signal is never worded as another step's failure, a person can go on, and every
  // place reads one state.
  it('exit 143 without a Stop ends the visit, names the step, and leaves the run a way on', async () => {
    await start((answered) => Promise.resolve({ ...answered, exitCode: 143, killReason: null, responseText: '' }));

    await resume();
    await settle(flow.app);

    const run = (await flow.app.app.get(RunRepository).findRun(KEY))!;
    const [visit] = await flow.app.app.get(VisitRepository).listStats(run.id);
    expect(visit).toMatchObject({ step: 'implement' });
    expect(visit.status).not.toBe('done');
    const view = await flow.app.app.get(RunQueriesService).flow(KEY);
    expect(view.currentStep).toBe('implement');
    expect(JSON.stringify(view.stateReason)).not.toContain('plan failed');
    expect(view.actions).toContain('resume');
    await assertSettled(flow.app);
  });

  it('its time limit on the fake clock settles the run waiting or stopped, with a reason', async () => {
    await start((answered) => {
      flow.app.clock.advance(TIME_LIMIT_MS);
      return Promise.resolve({ ...answered, exitCode: 1, killReason: 'time', responseText: '' });
    });

    await resume();
    await settle(flow.app);

    const visits = await flow.app.app
      .get(VisitRepository)
      .listStats((await flow.app.app.get(RunRepository).findRun(KEY))!.id);
    expect(visits[0]).toMatchObject({ step: 'implement', killReason: 'process killed: time' });
    expect(await stored()).toMatchObject({ state: 'waiting', reason: { code: 'NEEDS_ANSWERS' } });
    await assertSettled(flow.app);
  });

  it('a person’s Stop ends the agent and the run settles stopped, with Resume', async () => {
    let launches = 0;
    await start((answered) =>
      ++launches > 1
        ? Promise.resolve(answered)
        : new Promise((ended) => {
            flow.app.app
              .get(RunStop)
              .onHalted(() => ended({ ...answered, exitCode: 143, killReason: null, responseText: '' }));
          }),
    );

    void resume();
    await agent.launched();
    await flow.app.app.get(CommandService).submit('stop', KEY, {});
    await settle(flow.app);

    const { state, reason } = await stored();
    expect(reason?.code).toBe(REASON.stopped);
    expect(state).toBe('stopped');
    await assertSettled(flow.app);

    await flow.person('resume');
    expect((await stored()).state).toBe('done');
    await assertSettled(flow.app);
  });
});
