import { mkdirSync } from 'fs';
import { join } from 'path';
import type { BacklogTurnResult } from '../../../agent-result/definitions/backlog-turn';
import { emptyResult } from '../../../agent/agent-result';
import type { AgentRunResult } from '../../../agent/agent-result';
import { RunStop } from '../../../agent/run-stop';
import { AppConfig } from '../../../config/env';
import { testEnv } from '../../../config/env.spec-helpers';
import type { LiveBacklog } from '../../../contract/backlog-chat';
import { BacklogChatRepository } from '../../../history/backlog-chat.repository';
import { RuntimeCooldownRepository } from '../../../history/runtime-cooldown.repository';
import { VisitRepository } from '../../../history/visit.repository';
import type { Clock } from '../../../core/clock';
import { LiveHub } from '../../../live/live.hub';
import { AgentLauncher } from '../../../steps/shared/agent-launcher';
import { LimitFailover } from '../../../steps/shared/limit-failover';
import { resultAnswer } from '../../../testing/result-answer';
import { BacklogActionSupport } from '../backlog-action-support';
import { backlogHarness } from '../backlog.spec-helpers';
import { BacklogPlanner } from './backlog-planner';
import { PlannerTurnActions } from './planner-actions';
import { PlannerBacklogCalls } from './planner-backlog-calls';
import { PlannerRules } from './planner-rules';
import { PlannerRunPort, type PlannerRunCommand } from './planner-run-port';
import { BacklogTurnRunner } from './turn-runner';

/** One answer of the scripted planner agent: a turn result, a usage limit, or a launch that fails. */
export type TurnAnswer = BacklogTurnResult | 'limit' | 'crash';

/** The planner's agent: it answers every launch from a script and records what it was asked. */
export class ScriptedTurnAgent {
  readonly launches: { runtime: string; prompt: string; mounts: { readonly?: boolean }[] }[] = [];
  /** The answers still to give; an empty script answers with a turn that does nothing. */
  script: TurnAnswer[] = [];
  /** Held back until a spec lets it go, so it can add messages while a turn runs. */
  gate: Promise<void> | null = null;

  async run(input: { runtime: string; prompt: string; mounts: { readonly?: boolean }[] }): Promise<AgentRunResult> {
    this.launches.push({ runtime: input.runtime, prompt: input.prompt, mounts: input.mounts });
    await this.gate;
    const next = this.script.shift() ?? { say: '', actions: [] };
    const base = {
      ...emptyResult('time', 0, 1, new Date(0).toISOString()),
      killReason: null,
      tokensIn: 10,
      tokensOut: 5,
    };
    if (next === 'limit') return { ...base, usd: 0.25, responseText: 'limit', limit: { window: '5-hour' } };
    if (next === 'crash') return { ...base, exitCode: 1, responseText: '' };
    return { ...base, usd: 0.5, responseText: resultAnswer('Done.', next) };
  }
}

/** A command the planner sent to a run, with its key. */
export interface SentRunCommand {
  command: PlannerRunCommand;
  key: string;
}

/**
 * The planner over a real database, the real scheduler and action service, and a scripted agent. The worktrees and the
 * prompt are stand-ins: their own specs cover them.
 */
export async function plannerTurnsHarness(
  env: Record<string, string> = {},
  processOf: (config: AppConfig, clock: Clock) => { run(input: never): Promise<AgentRunResult> } = () =>
    new ScriptedTurnAgent(),
) {
  const h = await backlogHarness();
  const { db } = h;
  const config = new AppConfig(testEnv({ SWARMLOOP_ROOT: db.root, ...env }));
  const support = new BacklogActionSupport(h.backlogs, db.clock);
  const sent: SentRunCommand[] = [];
  const port = new PlannerRunPort();
  const failing = { next: null as Error | null };
  port.register(async (command, _owner, key) => {
    if (failing.next) {
      const error = failing.next;
      failing.next = null;
      throw error;
    }
    sent.push({ command, key });
  });
  const turns = new PlannerTurnActions(
    h.backlogs,
    db.app.get(BacklogChatRepository),
    new PlannerRules(h.backlogs, h.runs),
    new PlannerBacklogCalls(h.actions, support, h.backlogs, h.runs),
    port,
    db.clock,
  );
  const agent = processOf(config, db.clock) as ScriptedTurnAgent;
  const failover = new LimitFailover(
    config,
    db.clock,
    db.app.get(RuntimeCooldownRepository),
    db.app.get(VisitRepository),
  );
  const runStop = new RunStop();
  const launcher = new AgentLauncher(agent as never, db.app.get(VisitRepository), runStop, failover, config);
  const workspace = {
    opened: [] as string[],
    closed: [] as string[],
    open: async (_backlog: unknown, key: string) => {
      workspace.opened.push(key);
      const folder = join(db.root, 'worktrees', key);
      mkdirSync(join(folder, 'web'), { recursive: true });
      return {
        workspace: folder,
        mounts: [{ hostPath: join(folder, 'web'), containerPath: '/work/web', readonly: true }],
        names: ['web'],
      };
    },
    close: async (key: string) => {
      workspace.closed.push(key);
    },
  };
  const prompt = { build: async (name: string, key: string) => `plan ${name} in ${key}` };
  const chat = db.app.get(BacklogChatRepository);
  const runner = new BacklogTurnRunner(
    h.backlogs,
    chat,
    { read: async () => null } as never,
    workspace as never,
    prompt as never,
    launcher,
    turns,
    config,
    runStop,
  );
  const live = new LiveHub();
  const shown: LiveBacklog[] = [];
  live.onBacklog((entry) => shown.push(entry));
  const planner = () => new BacklogPlanner(h.backlogs, chat, runner, turns, h.scheduler(), db.clock, live);
  const started = planner();
  await started.start();
  const harness = {
    ...h,
    chat,
    runner,
    planner: started,
    agent,
    runStop,
    workspace,
    sent,
    shown,
    /** A person's message and the wake the chat route gives it. */
    async say(backlogId: number, text: string): Promise<void> {
      await chat.addPersonMessage(backlogId, text, `message:${text}`);
      harness.planner.wake(backlogId);
    },
    /** The next command the planner sends to a run fails with this error. */
    failNextSend(error: Error) {
      failing.next = error;
    },
    /** The server stops and starts again: a new planner over the same database. */
    async restart(): Promise<void> {
      await harness.planner.onModuleDestroy();
      harness.planner = planner();
      await harness.planner.start();
    },
    /** A new planner over the same database that is not started, as the planner of a CLI process is. */
    restartWithoutStart(): void {
      harness.planner = planner();
    },
    /** A running turn of the backlog that has taken what waits, as the planner makes one before it runs the turn. */
    async openTurn(backlogId: number, turnKey: string): Promise<void> {
      await chat.saveTurn({
        backlogId,
        turnKey,
        status: 'running',
        reason: '',
        nextTryAt: null,
        createdAt: db.clock.iso(),
      });
      await chat.takeInto(backlogId, turnKey);
    },
    /** The turns of the backlog, oldest first. */
    async turnsOf(backlogId: number) {
      return (await chat.turnsByStatus(['running', 'applied', 'done', 'failed', 'waiting'])).filter(
        (turn) => turn.backlogId === backlogId,
      );
    },
    /** The texts of the conversation, oldest first, as `author: text`. */
    async lines(backlogId: number): Promise<string[]> {
      return (await chat.lastMessages(backlogId, 100)).messages.map((item) => `${item.author}: ${item.text}`);
    },
    async close() {
      await harness.planner.onModuleDestroy();
      await h.scheduler().onModuleDestroy();
      await db.close();
    },
  };
  return harness;
}
