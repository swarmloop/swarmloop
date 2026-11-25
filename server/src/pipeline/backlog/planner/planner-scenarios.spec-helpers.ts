import { storeRun } from '../../../testing/store-run.spec-helpers';
import type { BacklogTurnAction, BacklogTurnResult } from '../../../agent-result/definitions/backlog-turn';
import type { Type } from '@nestjs/common';
import { AppConfig } from '../../../config/env';
import { testEnv } from '../../../config/env.spec-helpers';
import type { Clock } from '../../../core/clock';
import type { BacklogChatRepository } from '../../../history/backlog-chat.repository';
import type { BacklogRepository, BacklogTaskRecord } from '../../../history/backlog.repository';
import { RunRepository } from '../../../history/run.repository';
import { writeRunState, type RunStateChange } from '../../../history/run-state';
import type { CommandService } from '../../command.service';
import { BacklogActionSupport } from '../backlog-action-support';
import { BacklogActions } from '../backlog-actions';
import { BacklogQueries } from '../backlog-queries';
import { BacklogTaskActions } from '../backlog-task-actions';
import { holdServices } from '../../../steps/shared/question-holds.spec-helpers';
import { LeftQuestions } from './left-questions';
import { PlannerTurnActions } from './planner-actions';
import { PlannerBacklogCalls } from './planner-backlog-calls';
import { PlannerRules } from './planner-rules';
import { PlannerRunPort, type PlannerRunCommand } from './planner-run-port';
import { plannerDatabase } from './planner.spec-helpers';

/** A command the fake port was asked to send. */
export interface SentCommand {
  command: PlannerRunCommand;
  owner: string;
  key: string;
}

/** The turn's result a fake agent would answer: a message and the actions. */
export const turnResult = (say: string, ...actions: BacklogTurnAction[]): BacklogTurnResult => ({ say, actions });

/** What the planner's apply path is built from. */
interface PlannerParts {
  app: { get<T>(token: Type<T>): T };
  backlogs: BacklogRepository;
  chat: BacklogChatRepository;
  runs: RunRepository;
  clock: Clock;
  config: AppConfig;
  commands: CommandService;
  port: PlannerRunPort;
}

/** The planner's apply path and the parts a spec reaches into, built the way the server wires them. */
export function plannerTurnActions({ app, backlogs, chat, runs, clock, config, commands, port }: PlannerParts) {
  const queries = new BacklogQueries(backlogs, runs);
  const support = new BacklogActionSupport(backlogs, clock);
  const taskActions = new BacklogTaskActions(backlogs, queries, runs, commands, clock, support);
  const actions = new BacklogActions(backlogs, queries, clock, config, support, taskActions);
  const rules = new PlannerRules(backlogs, runs);
  const calls = new PlannerBacklogCalls(actions, support, backlogs);
  const { holds, passOn } = holdServices(app, clock);
  const left = new LeftQuestions(chat, holds, passOn, runs, backlogs, clock);
  const turns = new PlannerTurnActions(backlogs, chat, rules, calls, port, clock, left);
  return { rules, calls, turns };
}

/** The planner's apply path over a real database and a fake port that records what it is asked to send. */
export async function plannerHarness() {
  const db = await plannerDatabase();
  const runs = db.app.get(RunRepository);
  const commands = { submit: async () => ({ value: undefined, receipt: {} }) } as unknown as CommandService;
  const config = new AppConfig(testEnv({ SWARMLOOP_ROOT: db.root }));
  const sent: SentCommand[] = [];
  const failing = { next: null as Error | null };
  const port = new PlannerRunPort();
  port.register(async (command, owner, key) => {
    if (failing.next) {
      const error = failing.next;
      failing.next = null;
      throw error;
    }
    sent.push({ command, owner, key });
  });
  const { rules, calls, turns } = plannerTurnActions({
    app: db.app,
    backlogs: db.backlogs,
    chat: db.chat,
    runs,
    clock: db.clock,
    config,
    commands,
    port,
  });

  let position = 0;
  const harness = {
    ...db,
    rules,
    calls,
    turns,
    sent,
    runs,
    /** The next command the port is asked to send fails with this error. */
    failNext(error: Error) {
      failing.next = error;
    },
    /** A backlog of `owner` with the milestone M1 active and the requirements M1.R1 and M1.R2 open. */
    async seed(repositories: string[] = ['web', 'server']) {
      const backlogId = await db.addBacklog('alpha', repositories);
      const milestone = await db.backlogs.saveMilestone({
        backlogId,
        number: 1,
        title: 'First',
        goal: 'Goal',
        status: 'active',
        createdAt: db.clock.iso(),
      });
      for (const ref of ['M1.R1', 'M1.R2']) {
        await db.backlogs.saveRequirement({ milestoneId: milestone.id as number, ref, text: ref, status: 'open' });
      }
      return { backlogId, milestoneId: milestone.id as number };
    },
    task(backlogId: number, milestoneId: number | null, slug: string, overrides: Partial<BacklogTaskRecord> = {}) {
      position += 1;
      return db.backlogs.saveTask({
        backlogId,
        milestoneId,
        slug,
        title: slug,
        description: `Do ${slug}`,
        repositories: ['web'],
        covers: [],
        depends: [],
        files: [],
        proof: [],
        manual: false,
        fixesMain: null,
        status: 'waiting',
        runKey: null,
        note: '',
        runNow: false,
        mergeOk: false,
        merged: {},
        madeBy: 'person',
        position,
        createdAt: db.clock.iso(),
        ...overrides,
      });
    },
    /** A run the task holds, moved to a state the way a step would. */
    async run(key: string, change: RunStateChange) {
      const run = (await runs.findRun(key)) ?? runs.newWaitingRun(key, null, 'owner');
      writeRunState(run, change);
      await storeRun(runs, run);
    },
    async tasks(backlogId: number) {
      return db.backlogs.tasks(backlogId);
    },
    /** The texts of the planner's lines, oldest first. */
    async lines(backlogId: number): Promise<string[]> {
      return (await db.chat.lastMessages(backlogId, 100)).messages.map((message) => message.text);
    },
    async actionFacts(backlogId: number): Promise<Record<string, string>[]> {
      return (await db.backlogs.events(backlogId, 100))
        .filter((event) => event.kind === 'action')
        .reverse()
        .map((event) => event.facts);
    },
  };
  return harness;
}

type Harness = Awaited<ReturnType<typeof plannerHarness>>;

export async function withPlanner(body: (harness: Harness) => Promise<void>): Promise<void> {
  const harness = await plannerHarness();
  try {
    await body(harness);
  } finally {
    await harness.close();
  }
}
