import 'reflect-metadata';
import { PlanChatService } from '../api/plan-chat.service';
import { RunListRows } from '../api/run-list-rows';
import { RunQueriesService } from '../api/run-queries.service';
import { REASON, STOP_NOTE } from '../contract/run-state';
import { DocumentRepository } from '../history/document.repository';
import { PlanChatStore } from '../history/plan-chat.store';
import { RunRepository } from '../history/run.repository';
import { storedState, writeRunState, type RunStateChange } from '../history/run-state';
import { VisitStartRepository } from '../history/visit-start.repository';
import { CommandService } from '../pipeline/command.service';
import { PlannerTurns } from '../pipeline/planner-turns';
import { createFlowHarness } from './flow-harness';
import { assertInvariants } from './flow-invariants';
import { BlockAgentRunner, type ScriptedAnswer } from './result-answer';
import { remember } from './runs.spec-helpers';

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

  override async run(input: Parameters<BlockAgentRunner['run']>[0]) {
    if (this.seen && input.step === 'plan' && !this.atTurn && input.prompt?.includes('No step runs now')) {
      this.atTurn = await this.seen();
    }
    return super.run(input);
  }
}

describe('a person writes to the planner of a run no step drives', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let blocks: ProbedRunner;

  async function start(scripts: Record<string, ScriptedAnswer[]>): Promise<void> {
    blocks = new ProbedRunner({ ...scripts, plan: [firstPlan, ...(scripts.plan ?? [])] });
    flow = await createFlowHarness(KEY, { blocks, realImplement: 'all', implementCommits: true });
    flow.fastWaits();
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
      await flow.app.app.get(RunRepository).saveRun(run);
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
    await flow.app.app.get(RunRepository).saveRun(run);

    await writeAt(null, 'Please plan it small');

    expect(blocks.prompts.find((launch) => launch.step === 'plan-turn')?.prompt).toContain('Please plan it small');
    expect(blocks.steps[0]).toBe('research');
    expect((await runOf())?.currentStep).toBe('done');
    expect(await store().pending(KEY)).toEqual([]);
    expect((await turnStarts()).some((row) => row.startedBy === 'person')).toBe(true);
    await assertInvariants(flow.app);
  });

  it('refuses a planner’s replay of a stopped run that answers no message, and the run stays stopped with Resume', async () => {
    await start({});
    await flow.app.pipeline.runThrough(KEY, { auto: true });
    const run = (await runOf())!;
    writeRunState(run, STOPPED);
    await flow.app.app.get(RunRepository).saveRun(run);
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
