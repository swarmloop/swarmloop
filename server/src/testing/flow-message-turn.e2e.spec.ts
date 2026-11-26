import 'reflect-metadata';
import { storeRun } from './store-run.spec-helpers';
import { basename } from 'path';
import { PlanChatService } from '../api/plan-chat.service';
import { RunListRows } from '../api/run-list-rows';
import { RunQueriesService } from '../api/run-queries.service';
import { REASON, STOP_NOTE } from '../contract/run-state';
import { DocumentRepository } from '../history/document.repository';
import { PlanChatStore } from '../history/plan-chat.store';
import { RunRepository } from '../history/run.repository';
import { sessionFileName } from '../history/session-group';
import { storedState, writeRunState, type RunStateChange } from '../history/run-state';
import { VisitStartRepository } from '../history/visit-start.repository';
import { CommandService } from '../pipeline/command.service';
import { Reconciler } from '../pipeline/reconciler';
import { PlannerTurns } from '../pipeline/planner-turns';
import { createFlowHarness } from './flow-harness';
import { assertInvariants } from './flow-invariants';
import { BlockAgentRunner, type ScriptedAnswer } from './result-answer';
import { remember } from './runs.spec-helpers';
import { assertSettled, settle } from './faults/settle.spec-helpers';

const KEY = 'PROJ-710';
const FIRST = ['add the field - files: a.ts - proof: a.spec.ts'];

const block = (value: unknown): ScriptedAnswer => ({ block: value });
const firstPlan = block({ summary: ['planned'], plan: FIRST, covers: [['R1']] });

const STOPPED: RunStateChange = {
  status: 'blocked',
  currentStep: 'implement',
  reason: { code: REASON.stopped, message: STOP_NOTE },
};

/** What a person sees of the run, read the way each reader of the run's state reads it. */
interface Seen {
  stored: string;
  flow: string;
  resume: boolean;
  row: string;
}

/** Reads the run's state at the moment the planner's own turn starts, before its reply acts. */
class ProbedRunner extends BlockAgentRunner {
  seen: (() => Promise<Seen>) | null = null;
  atTurn: Seen | null = null;
  turnSessions: (string | undefined)[] = [];
  /** The fake clock's now: an outage ends there, so its next try is on the fake clock. */
  now: () => number = () => 0;

  override async run(input: Parameters<BlockAgentRunner['run']>[0]) {
    if (input.step === 'plan' && input.prompt?.includes('No step runs now')) this.turnSessions.push(input.sessionFile);
    if (this.seen && input.step === 'plan' && !this.atTurn && input.prompt?.includes('No step runs now')) {
      this.atTurn = await this.seen();
    }
    const result = await super.run(input);
    return result.outage ? { ...result, finishedAt: new Date(this.now()).toISOString() } : result;
  }
}

describe('a person writes to the planner of a run no step drives', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let blocks: ProbedRunner;

  async function start(scripts: Record<string, ScriptedAnswer[]>): Promise<void> {
    blocks = new ProbedRunner({ ...scripts, plan: [firstPlan, ...(scripts.plan ?? [])] });
    flow = await createFlowHarness(KEY, {
      blocks,
      realImplement: 'all',
      implementCommits: true,
      repoFiles: { 'AGENTS.md': '# rules\n\n- keep it small\n' },
    });
    flow.fastWaits();
    blocks.now = () => flow.app.clock.now();
    blocks.seen = async () => {
      const queries = flow.app.app.get(RunQueriesService);
      const view = await queries.flow(KEY);
      const { view: list } = await flow.app.app.get(RunListRows).read();
      return {
        stored: storedState((await runOf())!).state,
        flow: view.state,
        resume: view.actions.includes('resume'),
        row: list.runs.find((item) => item.key === KEY)!.state,
      };
    };
    const documents = flow.app.app.get(DocumentRepository);
    const run = await remember(flow.app.app.get(RunRepository), documents, KEY, 'plan', 'waiting');
    await documents.putDocument(run, 'requirement_list', '[{"id":"R1","text":"ship the field"}]\n');
  }

  /** The run drives to done once, then is put where the case needs it, and a person writes to its planner. */
  async function writeAt(change: RunStateChange | null, text: string): Promise<void> {
    if (change) {
      await flow.app.pipeline.runThrough(KEY, { auto: true });
      const run = (await runOf())!;
      writeRunState(run, change);
      await storeRun(flow.app.app.get(RunRepository), run);
      flow.app.clock.advance(1000);
    }
    await flow.app.app.get(PlanChatService).send(KEY, text, 'ana');
    await flow.app.app.get(PlannerTurns).idle();
    await flow.app.pipeline.whenIdle(KEY);
  }

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  const runOf = () => flow.app.app.get(RunRepository).findRun(KEY);
  const store = () => flow.app.app.get(PlanChatStore);
  const starts = async () => flow.app.app.get(VisitStartRepository).forRun((await runOf())!.id);
  const turnStarts = async () => (await starts()).filter((row) => row.outside && row.step === 'plan');

  it('replays a blocked run from implement with the instruction of the reply as the replay prompt', async () => {
    await start({
      'plan-turn': [block({ reply: 'Again.', replay: { step: 'implement', instruction: 'Fix the flag.' } })],
    });
    const blocked: RunStateChange = {
      status: 'blocked',
      currentStep: 'implement',
      reason: { code: REASON.blocked, message: 'blocked' },
    };

    await writeAt(blocked, 'The flag is wrong');

    const implement = blocks.prompts.filter((launch) => launch.step === 'implement');
    expect(implement.at(-1)?.prompt).toContain('Fix the flag.');
    expect((await runOf())?.currentStep).toBe('done');
    expect(await store().pending(KEY)).toEqual([]);
    expect((await store().read(KEY)).entries.some((entry) => entry.role === 'planner' && entry.text === 'Again.')).toBe(
      true,
    );
    expect((await turnStarts()).map((row) => row.startedBy)).toEqual(['person']);
    await assertInvariants(flow.app);
  });

  it('keeps a stopped run stopped with Resume until the reply acts, then resumes it as the person and takes the message', async () => {
    await start({ 'plan-turn': [block({ reply: 'Going on.', resume: true })] });

    await writeAt(STOPPED, 'Please go on');

    expect(blocks.atTurn).toEqual({ stored: 'stopped', flow: 'stopped', resume: true, row: 'stopped' });
    expect(blocks.steps.slice(blocks.steps.lastIndexOf('plan')).slice(0, 2)).toEqual(['plan', 'implement']);
    expect(await store().pending(KEY)).toEqual([]);
    const rows = await starts();
    expect(rows.filter((row) => !row.outside && row.step === 'plan').map((row) => row.startedBy)).toContain('person');
    await assertInvariants(flow.app);
  });

  it('leaves a stopped run stopped with Resume when the reply only answers, and says so in the chat', async () => {
    await start({ 'plan-turn': [block({ reply: 'The flag stays as it is.' })] });
    const steps = () => blocks.steps.length;

    await writeAt(STOPPED, 'Is the flag right?');
    const count = steps();

    expect(blocks.atTurn?.resume).toBe(true);
    const stopped = (await runOf())!;
    expect(storedState(stopped).state).toBe('stopped');
    expect((await flow.app.app.get(RunQueriesService).flow(KEY)).actions).toContain('resume');
    const last = (await store().read(KEY)).entries.at(-1);
    expect(last).toMatchObject({ role: 'planner', state: 'taken' });
    expect(last?.text).toContain('The flag stays as it is.');
    expect(last?.text).toContain('stays stopped');
    expect(await store().pending(KEY)).toEqual([]);
    expect(blocks.steps).toHaveLength(count);
    await assertInvariants(flow.app);
  });

  const OUTAGE = { outage: { host: 'api.anthropic.com', detail: 'API Error: 502' } };
  const planTurns = () => blocks.prompts.filter((launch) => launch.step === 'plan-turn').length;

  /** A stopped run gets a message and the model host does not answer; the server restarts. Returns the pending wait. */
  async function stoppedByOutage() {
    await writeAt(STOPPED, 'Please go on');
    expect((await runOf())?.status).toBe('blocked');
    expect(storedState((await runOf())!).state).toBe('stopped');
    expect((await flow.app.app.get(RunQueriesService).flow(KEY)).actions).toContain('resume');
    const [message] = await store().pending(KEY);
    expect(message.wait).toMatchObject({ on: 'model-host', message: expect.stringContaining('api.anthropic.com') });
    expect((await store().read(KEY)).entries.filter((entry) => entry.role === 'planner')).toEqual([]);
    await flow.restart();
    expect((await store().pending(KEY))[0].wait).toEqual(message.wait);
    return message.wait!;
  }

  it('keeps a stopped run stopped when the model host does not answer, and takes the message once at the next try', async () => {
    await start({ 'plan-turn': [OUTAGE, block({ reply: 'Going on.', resume: true })] });
    const wake = () => flow.app.app.get(Reconciler).resumeOutsideWaits();
    const idle = async () => {
      await flow.app.app.get(PlannerTurns).idle();
      await flow.app.pipeline.whenIdle(KEY);
    };

    const wait = await stoppedByOutage();
    await settle(flow.app);
    await assertSettled(flow.app);
    await wake();
    await idle();
    expect(planTurns()).toBe(1);

    flow.app.clock.advance(Date.parse(wait.retryAt) - flow.app.clock.now() + 1);
    await wake();
    await idle();
    expect(planTurns()).toBe(2);
    expect(await store().pending(KEY)).toEqual([]);
    expect((await runOf())?.currentStep).toBe('done');
    const starts = (await turnStarts()).map((row) => row.startedBy);
    expect(starts).toEqual(['person', 'person']);

    await wake();
    await idle();
    expect(planTurns()).toBe(2);
    await assertInvariants(flow.app);
    await settle(flow.app);
    await assertSettled(flow.app);
  });

  it('takes the message of a stopped run once in the reconciler pass after the outage next try', async () => {
    await start({ 'plan-turn': [OUTAGE, block({ reply: 'Going on.', resume: true })] });
    const pass = async () => {
      await flow.app.app.get(Reconciler).reconcileAll();
      await flow.app.app.get(PlannerTurns).idle();
      await flow.app.pipeline.whenIdle(KEY);
    };

    const wait = await stoppedByOutage();
    await pass();
    expect(planTurns()).toBe(1);

    flow.app.clock.advance(Date.parse(wait.retryAt) - flow.app.clock.now() + 1);
    await pass();
    expect(planTurns()).toBe(2);
    expect(await store().pending(KEY)).toEqual([]);

    await pass();
    expect(planTurns()).toBe(2);
    await settle(flow.app);
    await assertSettled(flow.app);
  });

  it('clears the wait when the retried reply fails for another reason, and the next pass does not launch it again', async () => {
    await start({ 'plan-turn': [OUTAGE, { text: 'no result block here' }] });
    const wait = await stoppedByOutage();
    await settle(flow.app);
    await assertSettled(flow.app);
    flow.app.clock.advance(Date.parse(wait.retryAt) - flow.app.clock.now() + 1);

    for (let pass = 0; pass < 2; pass++) {
      await flow.app.app.get(Reconciler).resumeOutsideWaits();
      await flow.app.app.get(PlannerTurns).idle();
    }

    expect(planTurns()).toBe(2);
    expect(await store().pending(KEY)).toEqual([]);
    expect(storedState((await runOf())!).state).toBe('stopped');
    await settle(flow.app);
    await assertSettled(flow.app);
  });

  it('resumes a run that waits in implement, and the resumed run takes the message before its next step', async () => {
    await start({ 'plan-turn': [block({ reply: 'Going on.', resume: true })] });

    await writeAt({ status: 'waiting', currentStep: 'implement' }, 'Also keep the old rows');

    expect((await runOf())?.currentStep).toBe('done');
    const after = blocks.steps.slice(blocks.steps.lastIndexOf('plan'));
    expect(after[0]).toBe('plan');
    expect(await store().pending(KEY)).toEqual([]);
    expect((await turnStarts()).map((row) => row.startedBy)).toEqual(['person']);
    await assertInvariants(flow.app);
  });

  it('starts the planner session of a run that is not planned yet, and resumes it at research', async () => {
    await start({ 'plan-turn': [block({ reply: 'Going on.', resume: true })] });
    const run = (await runOf())!;
    writeRunState(run, { ...STOPPED, currentStep: 'research' });
    await storeRun(flow.app.app.get(RunRepository), run);

    await writeAt(null, 'Please plan it small');

    expect(blocks.prompts.find((launch) => launch.step === 'plan-turn')?.prompt).toContain('Please plan it small');
    // The turn's chat is a one-off: it never writes the plan session that research and plan share.
    expect(blocks.turnSessions.map((file) => basename(file ?? ''))).not.toContain(sessionFileName(KEY, 'plan'));
    expect(blocks.steps[0]).toBe('research');
    expect((await runOf())?.currentStep).toBe('done');
    // Research opened the plan chat itself, so it sent the project rules.
    expect(blocks.prompts.find((launch) => launch.step === 'research')?.prompt).toContain('Project rules (');
    // The planner's turn is no plan visit: the first plan still gets the full prompt, not the follow-up of a re-plan.
    const plan = blocks.prompts.find((launch) => launch.step === 'plan')?.prompt ?? '';
    expect(plan).not.toBe('');
    expect(plan).not.toContain('The requirements in this message are the whole task.');
    expect(await store().pending(KEY)).toEqual([]);
    expect((await turnStarts()).some((row) => row.startedBy === 'person')).toBe(true);
    await assertInvariants(flow.app);
  });

  it('refuses a planner’s replay of a stopped run that answers no message, and the run stays stopped with Resume', async () => {
    await start({});
    await flow.app.pipeline.runThrough(KEY, { auto: true });
    const run = (await runOf())!;
    writeRunState(run, STOPPED);
    await storeRun(flow.app.app.get(RunRepository), run);
    const steps = blocks.steps.length;

    await expect(
      flow.app.app
        .get(CommandService)
        .submit('replay', KEY, { step: 'implement', prompt: 'Again.', by: 'planner', level: 0 }),
    ).rejects.toThrow();

    expect(storedState((await runOf())!).state).toBe('stopped');
    expect((await flow.app.app.get(RunQueriesService).flow(KEY)).actions).toContain('resume');
    expect(blocks.steps).toHaveLength(steps);
    await assertInvariants(flow.app);
  });
});
