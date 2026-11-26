import type { AgentHelper } from '../../../integrations/agent-runtime/agent-runtime';
import { mkdirSync } from 'fs';
import { join } from 'path';
import type { BacklogTurnResult } from '../../../agent-result/definitions/backlog-turn';
import { emptyResult } from '../../../agent/agent-result';
import type { AgentRunResult } from '../../../agent/agent-result';
import type { PricedRequest } from '../../../agent/request-usage';
import { RunStop } from '../../../agent/run-stop';
import { AppConfig } from '../../../config/env';
import { testEnv } from '../../../config/env.spec-helpers';
import type { LiveBacklog } from '../../../contract/backlog-chat';
import type { StateReason } from '../../../contract/run-state';
import { AgentCallRepository } from '../../../history/agent-call.repository';
import { DataSource } from 'typeorm';
import { AgentExchangeEntity } from '../../../history/agent-exchange.entity';
import { AttachmentStore } from '../../../history/attachment-store';
import { DocumentRepository } from '../../../history/document.repository';
import { BacklogChatRepository } from '../../../history/backlog-chat.repository';
import { VisitStartRepository } from '../../../history/visit-start.repository';
import { RuntimeCooldownRepository } from '../../../history/runtime-cooldown.repository';
import { VisitRepository } from '../../../history/visit.repository';
import type { Clock } from '../../../core/clock';
import { LiveHub } from '../../../live/live.hub';
import { AgentCallRecorder } from '../../../steps/shared/agent-call-recorder';
import { AgentLauncher } from '../../../steps/shared/agent-launcher';
import { CallContexts } from '../../../steps/shared/call-context';
import { LimitFailover } from '../../../steps/shared/limit-failover';
import { resultAnswer } from '../../../testing/result-answer';
import { BacklogActionSupport } from '../backlog-action-support';
import { backlogHarness } from '../backlog.spec-helpers';
import { BacklogPlanner } from './backlog-planner';
import { holdServices } from '../../../steps/shared/question-holds.spec-helpers';
import { LeftQuestions } from './left-questions';
import { PlannerTurnActions } from './planner-actions';
import { PlannerBacklogCalls } from './planner-backlog-calls';
import { PlannerRules } from './planner-rules';
import { PlannerRunPort, type PlannerRunCommand } from './planner-run-port';
import { eventFactsOf } from './planner-facts.spec-helpers';
import { BacklogTurnPrompt } from './turn-prompt';
import { BacklogTurnRunner } from './turn-runner';
import { BacklogTurnState } from './turn-state';
import { TurnTakes } from './turn-takes';
import { TurnTies } from './turn-ties';

/** One answer of the scripted planner agent: a turn result, a usage limit, a model host that did not answer, or a launch that fails. */
export type TurnAnswer = BacklogTurnResult | 'limit' | 'crash' | 'outage';

/** The planner's agent: it answers every launch from a script and records what it was asked. */
export class ScriptedTurnAgent {
  readonly launches: { runtime: string; prompt: string; mounts: { readonly?: boolean }[]; helper?: AgentHelper }[] = [];
  /** The answers still to give; an empty script answers with a turn that does nothing. */
  script: TurnAnswer[] = [];
  /** Held back until a spec lets it go, so it can add messages while a turn runs. */
  gate: Promise<void> | null = null;
  /** Runs before the launch answers, with what the launch tells when its start waits. */
  started: ((told?: () => Promise<void>) => Promise<void>) | null = null;

  async run(input: {
    onRequest?: (request: PricedRequest) => void;
    onStartWait?: () => Promise<void>;
    runtime: string;
    prompt: string;
    mounts: { readonly?: boolean }[];
    helper?: AgentHelper;
  }): Promise<AgentRunResult> {
    this.launches.push({ runtime: input.runtime, prompt: input.prompt, mounts: input.mounts, helper: input.helper });
    await this.started?.(input.onStartWait);
    await this.gate;
    const next = this.script.shift() ?? { say: '', actions: [] };
    const base = {
      ...emptyResult('time', 0, 1, new Date(0).toISOString()),
      killReason: null,
      tokensIn: 10,
      tokensOut: 5,
    };
    const answer = this.answerOf(next, base);
    // Every launch streams its one model request, as a real agent does, so the log holds what it spent even when it dies.
    input.onRequest?.({
      messageId: `request-${this.launches.length}`,
      model: 'opus',
      parentToolUseId: null,
      input: 10,
      cacheRead: 0,
      cacheWrite: 0,
      output: 5,
      usd: answer.usd,
      price: null,
    });
    return answer;
  }

  private answerOf(next: TurnAnswer, base: AgentRunResult): AgentRunResult {
    if (next === 'limit') return { ...base, usd: 0.25, responseText: 'limit', limit: { window: '5-hour' } };
    if (next === 'outage') {
      return { ...base, usd: 0.25, responseText: '', outage: { host: 'api.anthropic.com', detail: 'API Error: 502' } };
    }
    if (next === 'crash') return { ...base, usd: 0.1, exitCode: 1, responseText: '' };
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
  const chat = db.app.get(BacklogChatRepository);
  const backlogCalls = new PlannerBacklogCalls(h.actions, support, h.backlogs);
  const { holds, passOn } = holdServices(db.app, db.clock);
  const turns = new PlannerTurnActions(
    h.backlogs,
    chat,
    new PlannerRules(h.backlogs, h.runs),
    backlogCalls,
    port,
    db.clock,
    new LeftQuestions(chat, holds, passOn, h.runs, h.backlogs, db.clock),
  );
  const agent = processOf(config, db.clock) as ScriptedTurnAgent;
  const failover = new LimitFailover(
    config,
    db.clock,
    db.app.get(RuntimeCooldownRepository),
    db.app.get(VisitRepository),
  );
  const runStop = new RunStop();
  const startWait = { now: null as StateReason | null };
  const startWaits = {
    changed: (_key: string, store?: (wait: StateReason | null) => Promise<void>) => store?.(startWait.now),
  };
  const calls = db.app.get(AgentCallRepository);
  const recorder = new AgentCallRecorder(
    calls,
    new CallContexts(h.runs, h.backlogs, chat, db.app.get(VisitStartRepository)),
    db.clock,
  );
  const launcher = new AgentLauncher(
    agent as never,
    db.app.get(VisitRepository),
    runStop,
    failover,
    config,
    undefined,
    recorder,
    startWaits as never,
  );
  const failingOpen = { next: null as Error | null };
  const workspace = {
    opened: [] as string[],
    closed: [] as string[],
    open: async (_backlog: unknown, key: string) => {
      workspace.opened.push(key);
      if (failingOpen.next) {
        const error = failingOpen.next;
        failingOpen.next = null;
        throw error;
      }
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
  const state = new BacklogTurnState(
    h.backlogs,
    chat,
    h.runs,
    db.app.get(DocumentRepository),
    eventFactsOf(db.app, h.host),
  );
  // The brief is a stand-in; the follow-up is written by the real prompt over the real state.
  const prompt = {
    build: async (name: string, key: string) => `plan ${name} in ${key}`,
    followUp: (...input: Parameters<BacklogTurnPrompt['followUp']>) => new BacklogTurnPrompt(state).followUp(...input),
  };
  const takes = new TurnTakes(chat);
  const attachments = new AttachmentStore(config, db.clock);
  const live = new LiveHub();
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
    attachments,
    calls,
    new TurnTies(h.backlogs, chat, h.runs),
    takes,
    live,
  );
  const shown: LiveBacklog[] = [];
  live.onBacklog((entry) => shown.push(entry));
  const planner = () => new BacklogPlanner(h.backlogs, chat, runner, turns, h.scheduler(), db.clock, takes, live);
  const started = planner();
  await started.start();
  const harness = {
    ...h,
    chat,
    calls,
    launcher,
    runner,
    takes,
    attachments,
    planner: started,
    agent,
    runStop,
    startWait,
    workspace,
    sent,
    shown,
    /** A person's message and the wake the chat route gives it. */
    async say(backlogId: number, text: string): Promise<void> {
      await chat.addPersonMessage(backlogId, text, `message:${text}`, []);
      harness.planner.wake(backlogId);
    },
    /** The next command the planner sends to a run fails with this error. */
    failNextSend(error: Error) {
      failing.next = error;
    },
    /** The next opening of the turn's worktrees fails with this error. */
    failNextOpen(error: Error) {
      failingOpen.next = error;
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
    /** The rows the log holds for the turn's key, oldest first. */
    async logOf(turnKey: string) {
      return db.app
        .get(DataSource)
        .getRepository(AgentExchangeEntity)
        .find({ where: { turnKey }, order: { id: 'ASC' } });
    },
    /** A launch the server died in: an open row of the turn that already streamed a request costing `usd`. */
    async leaveOpen(turnKey: string, usd: number): Promise<number> {
      const id = await calls.open({
        kind: 'call',
        startedAt: db.clock.iso(),
        turnKey,
        step: 'backlog-plan',
        resumed: false,
        runtime: 'claude',
        model: 'opus',
        requestText: '',
      });
      await calls.addRequest(id, { model: 'opus', input: 10, cacheRead: 0, cacheWrite: 0, output: 5, usd, price: {} });
      return id;
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
