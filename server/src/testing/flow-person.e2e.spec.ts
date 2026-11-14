import 'reflect-metadata';
import { ERROR_CODES } from '../contract/error-codes';
import { actionsFor, NEEDS_PERSON, REASON } from '../contract/run-state';
import { deriveState, writeRunState } from '../history/run-state';
import { CommandService } from '../pipeline/command.service';
import { RunRepository } from '../history/run.repository';
import { createFlowHarness } from './flow-harness';
import { assertInvariants } from './flow-invariants';
import { git } from './runs.spec-helpers';

const KEY = 'PROJ-440';
const GB = 1024 ** 3;

describe('a run that needs a person ends in a state the person clears', () => {
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

  /** One reconciler pass, the hops it starts, and the invariants. */
  async function tick(): Promise<void> {
    await flow.tick();
    await flow.app.app.get(CommandService).idle();
    await flow.app.pipeline.whenIdle(KEY);
    await assertInvariants(flow.app);
  }

  /** The run is blocked with `code`, offers exactly the action `NEEDS_PERSON` names, and ticks leave it alone. */
  async function expectBlockedOn(code: string): Promise<string> {
    const { state, reason } = await stateNow();
    expect(state).toBe('blocked');
    expect(reason?.code).toBe(code);
    expect(actionsFor(state, code)).toContain(NEEDS_PERSON[code]);
    await tick();
    expect((await stateNow()).reason?.code).toBe(code);
    return reason?.message ?? '';
  }

  it('PIPELINE_UNFIXED offers Resume, and Resume runs the pipeline again', async () => {
    const run = await flow.begin('pipeline');
    flow.host.ci.pass(head());
    writeRunState(run, {
      status: 'blocked',
      reason: { code: ERROR_CODES.PIPELINE_UNFIXED, message: 'the pipeline is still red after 6 returns' },
    });
    await flow.app.app.get(RunRepository).saveRun(run);
    expect(await expectBlockedOn(ERROR_CODES.PIPELINE_UNFIXED)).toContain('still red');

    await flow.person('resume');
    await tick();
    expect((await stateNow()).state).toBe('done');
  });

  it('SPEND_LIMIT blocks before the step starts, and Resume runs it once the limit is raised', async () => {
    await flow.setEnv('MAX_RUN_USD', '25');
    await flow.begin('pipeline', { spentUsd: 30 });
    flow.host.ci.pass(head());

    await flow.app.pipeline.runThrough(KEY);
    expect(await expectBlockedOn(ERROR_CODES.SPEND_LIMIT)).toContain('raise MAX_RUN_USD, then Resume');
    expect(flow.host.ci.reads).toBe(0);

    await flow.setEnv('MAX_RUN_USD', '50');
    await flow.person('resume');
    await tick();
    expect((await stateNow()).state).toBe('done');
  });

  it('DISK_LOW blocks the step, waits while the disk stays low, and resumes once when space returns', async () => {
    await flow.begin('pipeline');
    flow.host.ci.pass(head());
    flow.diskFree(GB);

    await flow.app.pipeline.runThrough(KEY);
    await expectBlockedOn(ERROR_CODES.DISK_LOW);
    await tick();
    expect((await stateNow()).state).toBe('blocked');

    flow.diskFree(100 * GB);
    await tick();
    expect((await stateNow()).state).toBe('done');
    await tick();
    expect((await stateNow()).state).toBe('done');
  });

  it('CI_NOT_RUN: a run the host never starts asks a person, who resumes once it runs', async () => {
    await flow.begin('pipeline');
    flow.host.ci.queued(head());
    flow.host.ci.note('no runner picked the job up');
    flow.fastWaits();

    await flow.app.pipeline.runThrough(KEY);
    const message = await expectBlockedOn(REASON.ciNotRun);
    expect(message).toContain('CI host did not start run 9');
    expect(message).toContain(
      'tried: waited 3 minutes for the host to start the run; the host says: no runner picked the job up',
    );

    flow.host.ci.pass(head());
    await flow.person('resume');
    await tick();
    expect((await stateNow()).state).toBe('done');
  });

  it('CI_TIMEOUT: a run that keeps timing out is rerun, then asks a person', async () => {
    await flow.begin('pipeline');
    flow.host.ci.timedOut(head());
    flow.host.ci.note('the runner stopped answering');
    flow.fastWaits();

    await flow.app.pipeline.runThrough(KEY);
    const message = await expectBlockedOn(REASON.ciTimeout);
    expect(message).toContain('the runner stopped answering');
    expect(message).toContain('job: test');
    expect(message).toContain('tried: 2 reruns of the failed jobs');

    flow.host.ci.pass(head());
    await flow.person('resume');
    await tick();
    expect((await stateNow()).state).toBe('done');
  });
});
