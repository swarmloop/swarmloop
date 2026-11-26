import 'reflect-metadata';
import { RunQueriesService } from '../../api/run-queries.service';
import { PlanChatService } from '../../api/plan-chat.service';
import { DocumentRepository } from '../../history/document.repository';
import { PlanChatStore } from '../../history/plan-chat.store';
import { RunRepository } from '../../history/run.repository';
import { storedState } from '../../history/run-state';
import { CommandService } from '../../pipeline/command.service';
import { PlannerTurns } from '../../pipeline/planner-turns';
import { createFlowHarness } from '../flow-harness';
import { BlockAgentRunner, type ScriptedAnswer } from '../result-answer';
import { remember } from '../runs.spec-helpers';
import { assertSettled, settle } from './settle.spec-helpers';

const KEY = 'PROJ-901';
const block = (value: unknown): ScriptedAnswer => ({ block: value });
const FIRST = block({
  summary: ['planned'],
  plan: ['add the field - files: a.ts - proof: a.spec.ts'],
  covers: [['R1']],
});

/** An agent that holds its implement launch until the spec lets it end, so a Stop reaches a run that is working. */
class HeldImplement extends BlockAgentRunner {
  private reached!: () => void;
  private open!: () => void;
  readonly arrived = new Promise<void>((resolve) => (this.reached = resolve));
  private readonly gate = new Promise<void>((resolve) => (this.open = resolve));

  release(): void {
    this.open();
  }

  override async run(input: Parameters<BlockAgentRunner['run']>[0]) {
    if (input.step === 'implement' && input.runKey === KEY) {
      this.reached();
      await this.gate;
    }
    return super.run(input);
  }
}

describe('a person’s Stop, then an action of a person on the stopped run', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let agent: HeldImplement;

  /** A run is working at implement, a person stops it, and the agent ends. The run is stopped with Resume. */
  async function stopped(scripts: Record<string, ScriptedAnswer[]> = {}): Promise<void> {
    agent = new HeldImplement({ ...scripts, plan: [FIRST, ...(scripts.plan ?? [])] });
    flow = await createFlowHarness(KEY, { blocks: agent, realImplement: 'all', implementCommits: true });
    flow.fastWaits();
    const documents = flow.app.app.get(DocumentRepository);
    const run = await remember(flow.app.app.get(RunRepository), documents, KEY, 'plan', 'waiting');
    await documents.putDocument(run, 'requirement_list', '[{"id":"R1","text":"ship the field"}]\n');
    const going = flow.app.pipeline.runThrough(KEY, { auto: true });
    await agent.arrived;
    await flow.app.app.get(CommandService).submit('stop', KEY, {});
    agent.release();
    await going;
    await settle(flow.app);
    await expectStopped();
  }

  const find = async () => (await flow.app.app.get(RunRepository).findRun(KEY))!;
  const actions = async () => (await flow.app.app.get(RunQueriesService).flow(KEY)).actions;
  const submit = (type: Parameters<CommandService['submit']>[0], payload: Record<string, unknown> = {}) =>
    flow.app.app.get(CommandService).submit(type, KEY, payload);

  async function expectStopped(): Promise<void> {
    expect(storedState(await find()).state).toBe('stopped');
    expect(await actions()).toContain('resume');
  }

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  it('resumes the stopped run, which goes on from implement and ends done', async () => {
    await stopped();

    await flow.person('resume');
    await settle(flow.app);

    expect((await find()).currentStep).toBe('done');
    await assertSettled(flow.app);
  });

  it('keeps the run stopped with Resume when a message to the planner is only answered', async () => {
    await stopped({ 'plan-turn': [block({ reply: 'It stays stopped until you resume.' })] });

    await flow.app.app.get(PlanChatService).send(KEY, 'Is it right?', 'ana');
    await flow.app.app.get(PlannerTurns).idle();
    await settle(flow.app);

    await expectStopped();
    expect(await flow.app.app.get(PlanChatStore).pending(KEY)).toEqual([]);
    await assertSettled(flow.app);
  });

  it('replays the stopped run from implement, and it ends settled', async () => {
    await stopped();

    await submit('replay', { step: 'implement', prompt: 'Again.' });
    await settle(flow.app);

    expect((await find()).currentStep).toBe('done');
    await assertSettled(flow.app);
  });

  it('takes a Rebase of the stopped run, which goes on and ends done', async () => {
    await stopped();

    await submit('rebase');
    await settle(flow.app);

    expect(storedState(await find()).state).toBe('done');
    await assertSettled(flow.app);
  });

  it('refuses an answer for a stopped run that asked nothing, and the run stays stopped with Resume', async () => {
    await stopped();

    await expect(submit('answer', { message: 'hello' })).rejects.toThrow();
    await settle(flow.app);

    await expectStopped();
    await assertSettled(flow.app);
  });

  it('removes the stopped run, and nothing of it is left', async () => {
    await stopped();

    await submit('remove');
    await settle(flow.app);

    expect(await flow.app.app.get(RunRepository).findRun(KEY)).toBeNull();
    await assertSettled(flow.app);
  });
});
