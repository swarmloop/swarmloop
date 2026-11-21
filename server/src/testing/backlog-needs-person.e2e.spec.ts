import 'reflect-metadata';
import { join } from 'path';
import { BacklogChatService } from '../api/backlog-chat.service';
import { BacklogRepository } from '../history/backlog.repository';
import { RunRepository } from '../history/run.repository';
import { storedState } from '../history/run-state';
import { remoteProject } from '../integrations/code-host/remote-project';
import { BacklogPlanner } from '../pipeline/backlog/planner/backlog-planner';
import { CommandService } from '../pipeline/command.service';
import { FAKE_MODEL_KEY } from './env.spec-helpers';
import { createFlowHarness } from './flow-harness';
import { DEFAULT_RESEARCH, BlockAgentRunner } from './result-answer';
import { DocumentRepository } from '../history/document.repository';
import { git, remember } from './runs.spec-helpers';

const KEY = 'b03';
const OWNER = 'owner';
const BACKLOG = 'shop';
const QUESTION = 'Which field is optional?';

describe('a backlog whose run waits for a person', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  beforeEach(async () => {
    const blocks = new BlockAgentRunner({
      research: [{ block: { ...DEFAULT_RESEARCH, questions: [QUESTION] } }],
      'backlog-plan': [{ block: { say: `The run asks: ${QUESTION} Which one is it?`, actions: [] } }],
    });
    flow = await createFlowHarness(KEY, {
      env: { CHECKOUTS_ROOT: '.', ...FAKE_MODEL_KEY },
      realImplement: false,
      realReview: false,
      blocks,
    });
    // The origin is an url, so the backlog layer reads a project from it.
    const url = `file://${join(flow.app.root, 'demo.git')}`;
    git(join(flow.app.root, 'demo'), ['remote', 'set-url', 'origin', url]);
    remoteProject(url);
    flow.host.defaultBranchPasses();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.app.app.get(CommandService).idle();
    await flow.close();
  });

  const backlogs = () => flow.app.app.get(BacklogRepository);

  async function setUp(): Promise<number> {
    const { actions } = flow.backlog();
    await actions.createBacklog(OWNER, { name: BACKLOG, repositories: ['demo'], mergeMode: 'green' });
    await actions.proposeMilestone(OWNER, BACKLOG, { title: 'Ship the shop', goal: 'Customers can order.' });
    await actions.addRequirements(OWNER, BACKLOG, 1, { texts: ['Orders can be placed'] });
    await actions.addTasks(OWNER, BACKLOG, [
      {
        id: 'a',
        title: 'Task a',
        description: 'Do a.',
        repositories: ['demo'],
        files: ['src/a.ts'],
        proof: ['a.spec.ts'],
        milestone: 1,
        covers: ['M1.R1'],
        depends: [],
      },
    ]);
    await actions.runMilestone(OWNER, BACKLOG, 1);
    return (await backlogs().findBacklog(BACKLOG))!.id as number;
  }

  /** The run the scheduler started goes through research, which asks its question, and waits there. */
  async function untilAsked(id: number): Promise<string> {
    await flow.backlog().scheduler.tick();
    const runKey = (await backlogs().tasks(id))[0].runKey as string;
    const { app } = flow.app;
    await remember(app.get(RunRepository), app.get(DocumentRepository), runKey, 'research', 'waiting');
    await flow.app.pipeline.step('research', runKey);
    await flow.app.pipeline.whenIdle(runKey);
    await flow.tick();
    const run = (await app.get(RunRepository).findRun(runKey))!;
    expect([run.currentStep, run.status]).toEqual(['research', 'waiting']);
    return runKey;
  }

  it('records run-needs-person within one pass and wakes the planner, which asks the person', async () => {
    const id = await setUp();
    const runKey = await untilAsked(id);

    await flow.backlog().scheduler.tick();
    await flow.app.app.get(BacklogPlanner).whenIdle();

    const events = (await backlogs().events(id, 100)).filter((event) => event.kind === 'run-needs-person');
    expect(events).toHaveLength(1);
    expect(events[0].facts).toMatchObject({ slug: 'a', runKey });
    expect(events[0].turn).not.toBeNull();
    const chat = await flow.app.app.get(BacklogChatService).chat(BACKLOG);
    expect(chat.turns.map((turn) => turn.status)).toEqual(['done']);
    expect(chat.messages.map((message) => [message.author, message.text.includes(QUESTION)])).toEqual([
      ['planner', true],
    ]);
    const run = (await flow.app.app.get(RunRepository).findRun(runKey))!;
    expect(storedState(run)).toMatchObject({ state: 'waiting', reason: { code: 'NEEDS_ANSWERS' } });
  });
});
