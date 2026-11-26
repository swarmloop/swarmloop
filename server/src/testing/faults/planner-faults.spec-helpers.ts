import { join } from 'path';
import { BacklogChatService } from '../../api/backlog-chat.service';
import { runTaskStatus } from '../../contract/subtask';
import { REASON } from '../../contract/reason-words';
import { BacklogRepository } from '../../history/backlog.repository';
import { RunRepository } from '../../history/run.repository';
import { storedState, writeRunState } from '../../history/run-state';
import { remoteProject } from '../../integrations/code-host/remote-project';
import { BacklogPlanner } from '../../pipeline/backlog/planner/backlog-planner';
import { FAKE_MODEL_KEY } from '../env.spec-helpers';
import { createFlowHarness } from '../flow-harness';
import { BlockAgentRunner, type ScriptedAnswer } from '../result-answer';
import { git } from '../runs.spec-helpers';
import { storeRun } from '../store-run.spec-helpers';

export const OWNER = 'owner';
export const BACKLOG = 'shop';
/** Longer than the window of the usage limit a waiting turn is held by. */
export const PAST_THE_LIMIT = 6 * 60 * 60_000;

/** Two runtimes, so a usage limit on one is tried on the other and then the turn waits. */
const ENV = { CHECKOUTS_ROOT: '.', ...FAKE_MODEL_KEY, AGENTS_BACKLOG_PLAN: 'claude:m-claude,codex:m-codex' };

/** The answer of a planner turn that ends without its result block: the turn fails. */
export const NO_RESULT: ScriptedAnswer = { text: 'I looked at it and have nothing to give.' };
/** The answer of a planner turn that hits the usage limit of its runtime; one per runtime makes the turn wait. */
export const LIMIT: ScriptedAnswer = { limit: { window: '5-hour' } };

/** A planner answer with something to say and nothing to do. */
export function says(say: string): { block: { say: string; actions: unknown[] } } {
  return { block: { say, actions: [] } };
}

type Harness = Awaited<ReturnType<typeof createFlowHarness>>;

/** A launch of the planner that is held open until `release`; `reached` resolves when the launch got there. */
export interface Hold {
  reached: Promise<void>;
  release: () => void;
}

/** The planner's launches of a boot: their prompts, the answers they get in order, and the ones held open. */
export interface PlannerLaunches {
  prompts: string[];
  /** The next answers of the planner turns; an empty turn when none is left. */
  answers: ScriptedAnswer[];
  /** The next launch of the planner waits until the returned hold is released. */
  holdNext(): Hold;
}

export interface PlannerBoot extends PlannerLaunches {
  flow: Harness;
  /** A backlog with one milestone and one task, run started; returns the backlog id. */
  backlogWithTask(): Promise<number>;
  /** The scheduler gives the task its run; returns the run key. */
  startRun(id: number): Promise<string>;
  /** A started task whose run stands blocked at checks, as no step drives it. */
  blockedTask(): Promise<string>;
  /** A person's message to the planner. */
  say(text: string): Promise<unknown>;
  /** The conversation of the backlog as the dashboard reads it. */
  chat(): ReturnType<BacklogChatService['chat']>;
  /** The planner finished everything that runs. */
  idle(): Promise<void>;
}

/**
 * Boots the real application with two planner runtimes on jest's fake timers (setImmediate and nextTick stay real).
 * The planner's launches go through the fake runtime, which this wrapper holds open on request. Call `jest.useRealTimers()`
 * and `flow.close()` in afterEach.
 */
export async function bootPlanner(scripts: Record<string, ScriptedAnswer[]> = {}): Promise<PlannerBoot> {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  const holds: { gate: Promise<void>; reached: () => void }[] = [];
  const launches: PlannerLaunches = {
    prompts: [],
    answers: [],
    holdNext() {
      let release = (): void => undefined;
      let reached = (): void => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const arrived = new Promise<void>((resolve) => (reached = resolve));
      holds.push({ gate, reached });
      return { reached: arrived, release };
    },
  };
  const blocks = new BlockAgentRunner(scripts);
  const base = blocks.run.bind(blocks);
  blocks.run = async (input) => {
    if (input.step !== 'backlog-plan') return base(input);
    launches.prompts.push(input.prompt ?? '');
    const hold = holds.shift();
    if (hold) {
      hold.reached();
      await hold.gate;
    }
    const next = launches.answers.shift();
    return next ? new BlockAgentRunner({ 'backlog-plan': [next] }).run(input) : base(input);
  };
  const flow = await createFlowHarness('b05', { env: ENV, realImplement: false, realReview: false, blocks });
  const url = `file://${join(flow.app.root, 'demo.git')}`;
  git(join(flow.app.root, 'demo'), ['remote', 'set-url', 'origin', url]);
  remoteProject(url);
  flow.host.defaultBranchPasses();
  const get = <T>(token: new (...args: never[]) => T): T => flow.app.app.get(token);

  async function backlogWithTask(): Promise<number> {
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
    return (await get(BacklogRepository).findBacklog(BACKLOG))!.id as number;
  }

  async function startRun(id: number): Promise<string> {
    await flow.backlog().scheduler.tick();
    return (await get(BacklogRepository).tasks(id))[0].runKey as string;
  }

  async function blockedTask(): Promise<string> {
    const id = await backlogWithTask();
    const runKey = await startRun(id);
    await flow.app.pipeline.whenIdle(runKey);
    const runs = get(RunRepository);
    const run = (await runs.findRun(runKey))!;
    writeRunState(run, {
      status: 'blocked',
      currentStep: 'checks',
      reason: { code: REASON.loopLimit, message: 'checks ran 3 times (MAX_RETURNS)' },
    });
    await storeRun(runs, run);
    const backlogs = get(BacklogRepository);
    const [task] = await backlogs.tasks(id);
    await backlogs.saveTask({
      ...task,
      status: runTaskStatus({ state: storedState(run).state, currentStep: run.currentStep }),
    });
    return runKey;
  }

  return {
    ...launches,
    flow,
    backlogWithTask,
    startRun,
    blockedTask,
    say: (text) => get(BacklogChatService).post(OWNER, BACKLOG, text, `m-${text}`),
    chat: () => get(BacklogChatService).chat(BACKLOG),
    idle: () => get(BacklogPlanner).whenIdle(),
  };
}
