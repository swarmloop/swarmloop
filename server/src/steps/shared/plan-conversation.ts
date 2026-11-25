import { join } from 'path';
import { Injectable } from '@nestjs/common';
import { agentFor } from '../../config/agents';
import { AppConfig } from '../../config/env';
import { resumableChat } from '../../agent/agent-session';
import { StepStopped } from '../../agent/step-stopped';
import { Clock } from '../../core/clock';
import { visitStatus } from '../../core/pipeline-result';
import { SwarmloopError } from '../../core/swarmloop-error';
import { mountsForStep, repoNames, checkedRepoNames } from '../../git/repo-names';
import { DocumentRepository } from '../../history/document.repository';
import type { RunEntity } from '../../history/entities';
import { PlanChatStore } from '../../history/plan-chat.store';
import { root } from '../../history/run-paths';
import { VisitRepository } from '../../history/visit.repository';
import { isSubtask, type Subtask } from '../../contract/subtask';
import type { Requirement } from '../../contract/requirement-list';
import { completePlan, type PlanResult } from '../../agent-result/definitions/plan';
import { replyHasPlan, planReplyFor, type PlanReplyResult } from '../../agent-result/definitions/plan-reply';
import type { ResultDefinition } from '../../agent-result/result-definition';
import { ARTIFACTS } from '../contract/artifacts';
import type { ArtifactValue } from '../contract/step-contract';
import type { ModelStepContext } from '../model-step-context';
import { planFields, readPlan, renderSummary, withPlan } from '../plan/plan-record';
import { coverageUnits } from '../plan/plan-coverage';
import {
  addTasksCheck,
  buildGraph,
  isSplit,
  planItemsFromTasks,
  splitLimits,
  splitOutputs,
  startedTasks,
  withAddedTasks,
  type StoredGraph,
  type TaskLimits,
} from '../plan/plan-tasks';
import { improveUnits } from '../plan-improve/plan-improve-coverage';
import type { OpenedStep } from '../step-run';
import { agentFailure } from './agent-result';
import { AgentDoor } from './agent-door';
import type { LaunchResult } from './result-exchange';
import { plannerStart, type LookStart } from './look-start';
import { requirementsBrief } from './requirements-brief';
import { StartRefused } from './start-refused';
import { correctCoverage } from './coverage-correction';
import { currentPlan } from './current-plan';
import { storedGraph } from './stored-graph';
import { modelVisit } from './model-visit';
import { HOST_VISIT, ModelHostUnavailable } from './model-host-unavailable';
import { ResultInvalid } from './answer-errors';
import { answerErrorsDocument } from './stored-answer-errors';
import { planErrors } from './plan-errors';
import { buildRevision } from './plan-revision';
import { withAdditions } from './requirement-additions';
import { implementedWithoutTasks } from './amendment';
import { coverageOf } from './requirement-coverage';

/** Orders the turns of the planner of one run, so only one runs at a time. */
interface TurnGate {
  exclusive<T>(key: string, turn: { id: string; at: string; text: string }, work: () => Promise<T>): Promise<T>;
}

/** What a reply leaves for the step that asked: the documents it writes and the handoff of a changed plan. */
interface AppliedReply {
  outputs: ArtifactValue[];
  handoff?: string;
}

/** The planner's own chat: the one way to run a planner turn outside the plan step, and the one way to apply its reply. */
@Injectable()
export class PlanConversation {
  /** Set by the server's planner turns, so a turn started here waits for the one that runs. */
  gate?: TurnGate;

  constructor(
    private readonly door: AgentDoor,
    private readonly visits: VisitRepository,
    private readonly documents: DocumentRepository,
    private readonly config: AppConfig,
    readonly clock: Clock,
    readonly chat: PlanChatStore,
  ) {}

  private readonly replyingKeys = new Set<string>();

  /** Marks the planner of the run as replying while `work` runs: the plan step's own visit for a person's message. */
  async whileReplying<T>(key: string, work: () => Promise<T>): Promise<T> {
    this.replyingKeys.add(key);
    try {
      return await work();
    } finally {
      this.replyingKeys.delete(key);
    }
  }

  /** True while the plan step writes a reply to a person's message. */
  isReplying(key: string): boolean {
    return this.replyingKeys.has(key);
  }

  /** What a reply may do: a run that implemented without splitting amends its plan and may not split, whatever its settings. */
  async limits(run: RunEntity): Promise<TaskLimits> {
    const base = splitLimits(run, this.config.env.SPLIT_MAX_TASKS);
    return (await implementedWithoutTasks(this.documents, this.visits, run)) ? { ...base, maySplit: false } : base;
  }

  /** Runs `work` as a turn of the planner of the run: after the turn that runs, when the server orders them. */
  ordered<T>(key: string, turn: { id: string; at: string; text: string }, work: () => Promise<T>): Promise<T> {
    return this.gate ? this.gate.exclusive(key, turn, work) : work();
  }

  /**
   * A follow-up visit of the plan step in the plan chat of the run, in plan mode with the read-only plan tools and the
   * plan step's mounts, recorded like any visit of that step. Null when the run has no plan chat yet or the planner
   * gave no usable answer. `prompt` gets the name of the result the chat last received.
   */
  async visit(
    opened: OpenedStep,
    prompt: (received: string | null) => string,
    definition: ResultDefinition,
    check: (value: unknown) => string[] = () => [],
    entries: string[] = [],
    start?: LookStart,
  ): Promise<{ value: unknown } | { refused: StartRefused } | null> {
    const run = opened.run;
    const env = this.config.env;
    const { runtime, model, ...effort } = agentFor(env, run, 'plan');
    const dir = root(this.config);
    const chat = await resumableChat(dir, run.key, 'plan', runtime);
    if (!chat?.chatId) return null;
    const text = prompt(chat.resultName ?? null);
    let result: LaunchResult | null = null;
    let failure: string | null = null;
    let hostWait: ModelHostUnavailable | null = null;
    let answerErrors: string[] | null = null;
    const started: { id: string | null } = { id: null };
    try {
      const names = repoNames((await this.documents.latestBody(run.key, ARTIFACTS.repos.kind)) ?? '');
      const plan = (await currentPlan(this.documents, run.key))?.items ?? [];
      const brief = requirementsBrief((await this.documents.latestBody(run.key, ARTIFACTS.requirements.kind)) ?? '');
      result = await this.door.outside(
        {
          step: 'plan',
          ...plannerStart(start, [...plan, brief, ...entries]),
          admitted: (id) => {
            started.id = id;
          },
        },
        {
          root: dir,
          run,
          key: run.key,
          step: 'plan',
          mode: 'plan',
          tools: 'plan',
          runtime,
          model,
          ...effort,
          timeLimitMs: env.PLAN_TIMEOUT_MS,
          prompt: text,
          result: definition,
          check,
          workspace: join(dir, 'worktrees', run.key),
          mounts: mountsForStep(dir, run.key, names, run.targetPath),
        },
      );
      failure = agentFailure(result, 'plan', 'plan');
    } catch (error) {
      if (error instanceof StepStopped) throw error;
      if (error instanceof StartRefused) return { refused: error };
      const kept = keptOf(error, result);
      ({ result, hostWait, answerErrors } = { result: kept.result, ...kept.rest });
      failure = error instanceof SwarmloopError ? error.message : 'plan failed';
    }
    const value = failure ? undefined : result?.resultValue;
    const ok = value !== undefined;
    const ended = { result, ok, hostWait, answerErrors };
    await this.storeVisit(opened, { runtime, model, ...effort }, text, ended, started.id);
    if (hostWait) throw hostWait;
    return ok ? { value } : null;
  }

  /** Stores the visit with its cost, links it to its start, and keeps what an outage or an invalid answer leaves with it. */
  private async storeVisit(
    opened: OpenedStep,
    agent: { runtime: string; model: string },
    prompt: string,
    ended: {
      result: LaunchResult | null;
      ok: boolean;
      hostWait: ModelHostUnavailable | null;
      answerErrors: string[] | null;
    },
    startId: string | null,
  ): Promise<void> {
    const { result, ok, hostWait, answerErrors } = ended;
    const draft = modelVisit({
      opened,
      now: this.clock.now(),
      step: 'plan',
      mode: 'plan',
      ...agent,
      agent: result,
      prompt,
      status: hostWait ? HOST_VISIT.status : visitStatus(ok ? 'ok' : 'failed'),
      exitCode: ok ? 0 : 1,
      documents: answerErrors ? [answerErrorsDocument(answerErrors)] : undefined,
    });
    const stat = await this.visits.finishVisit(
      opened.run,
      hostWait ? { ...draft, killReason: HOST_VISIT.killReason } : draft,
    );
    if (startId) await this.door.linkVisit(startId, stat.id);
  }

  /**
   * Checks the plan of a reply as a first plan, adds its requirements, records the reply with the revision it made and
   * returns what the plan step writes. A reply with no plan and no requirements keeps the stored plan.
   */
  async applyReply(ctx: ModelStepContext, reply: PlanReplyResult, reason: string): Promise<AppliedReply> {
    const list = await ctx.reread(ARTIFACTS.requirementList);
    const grown = withAdditions(list ?? [], reply.requirements ?? []);
    const grew = grown.length > (list?.length ?? 0);
    if (!replyHasPlan(reply) && !grew) {
      await this.record(ctx, reply, reason, null);
      return { outputs: [] };
    }
    const stored = await this.startedGraph(ctx);
    const coverage = grown.length > 0 ? await this.checkedCoverage(ctx, reply, grown, stored) : null;
    const final = coverage?.value ?? reply;
    const kept = [
      ...(grew ? [{ artifact: ARTIFACTS.requirementList, value: grown }] : []),
      ...(coverage
        ? [{ artifact: ARTIFACTS.requirementCoverage, value: coverageOf(coverage.list, coverage.units) }]
        : []),
    ];
    if (!replyHasPlan(final)) {
      await this.record(ctx, reply, reason, null);
      return { outputs: kept };
    }
    const changed = await this.changedPlan(ctx, completePlan(final), reply, reason, stored);
    return { outputs: [...changed.outputs, ...kept], handoff: changed.handoff };
  }

  /** Records the revision of a reply that holds a plan, and gives the plan outputs of the plan step. */
  private async changedPlan(
    ctx: ModelStepContext,
    result: PlanResult,
    reply: PlanReplyResult,
    reason: string,
    stored: StoredGraph | null,
  ): Promise<Required<AppliedReply>> {
    const run = ctx.opened.run;
    const graph = stored ? this.merged(stored, result) : isSplit(result) ? buildGraph(result) : null;
    const body = (await ctx.reread(ARTIFACTS.requirements)) ?? '';
    const before = readPlan(body);
    const fields = graph
      ? planFields(planItemsFromTasks(graph.tasks), before?.name, before?.overview)
      : planFields(result.plan, before?.name, before?.overview);
    const prior = (await currentPlan(this.documents, run.key))?.items ?? [];
    await this.record(ctx, reply, reason, { before: prior, after: fields.items });
    return {
      outputs: [
        { artifact: ARTIFACTS.requirements, value: withPlan(body, fields) },
        { artifact: ARTIFACTS.planResult, value: graph && stored ? withTasksOf(result, graph.tasks) : result },
        ...((await this.limits(run)).maySplit ? splitOutputs(graph) : []),
      ],
      handoff: renderSummary(result.summary, fields.items),
    };
  }

  /** The reply checked against the requirement list as it grew: a gap goes back once, in the same chat, with the same check. */
  private async checkedCoverage(
    ctx: ModelStepContext,
    reply: PlanReplyResult,
    grown: Requirement[],
    stored: StoredGraph | null,
  ) {
    const run = ctx.opened.run;
    const limits = await this.limits(run);
    const subtask = isSubtask(run);
    const coverage = (await ctx.reread(ARTIFACTS.requirementCoverage)) ?? [];
    const names = checkedRepoNames((await ctx.reread(ARTIFACTS.repos)) ?? []);
    return correctCoverage(
      ctx,
      {
        mounts: mountsForStep(root(this.config), run.key, names, run.targetPath),
        result: planReplyFor({ split: limits.maySplit, subtask, ...(stored ? { addTasksOnly: true } : {}) }),
        check: stored
          ? addTasksCheck(stored, limits)
          : (value) => planErrors(completePlan(value as Partial<PlanResult>), limits, subtask),
        read: (value) => ({ ...(value as PlanReplyResult), requirements: reply.requirements }),
        listOf: () => grown,
        unitsOf: (value) =>
          stored
            ? coverageUnits({ ...completePlan({}), tasks: this.merged(stored, completePlan(value)).tasks })
            : improveUnits(completePlan(value), coverage),
      },
      reply,
    );
  }

  /** The stored graph of a split run whose tasks started: a reply to it only adds tasks. Null for any other run. */
  private async startedGraph(ctx: ModelStepContext): Promise<StoredGraph | null> {
    const run = ctx.opened.run;
    if (!(await this.limits(run)).maySplit) return null;
    const stored = await storedGraph(ctx);
    return startedTasks(stored.tasks).length > 0 ? stored : null;
  }

  /** The stored graph with the tasks of a checked reply appended. */
  private merged(stored: StoredGraph, reply: PlanResult) {
    const { graph, errors } = withAddedTasks(stored, reply, { maySplit: true, maxTasks: Number.POSITIVE_INFINITY });
    if (!graph) throw new SwarmloopError(`added tasks are not valid: ${errors.join('; ')}`);
    return graph;
  }

  /** The reply entry, and the revision when the plan items changed. A reply of an event that was recorded is not written again. */
  private async record(
    ctx: ModelStepContext,
    reply: PlanReplyResult,
    reason: string,
    items: { before: string[]; after: string[] } | null,
  ): Promise<void> {
    const key = ctx.opened.run.key;
    const entryKey = `reply-${ctx.opened.startedAt}`;
    const log = await this.chat.read(key);
    if (log.entries.some((entry) => entry.key === entryKey)) return;
    const at = this.clock.iso();
    const changed = items && JSON.stringify(items.before) !== JSON.stringify(items.after);
    const revision = changed ? buildRevision({ ...items, reason, known: log.revisions, at }) : null;
    if (revision) await this.chat.appendRevision(key, revision);
    await this.chat.appendEntry(key, {
      key: entryKey,
      role: 'planner',
      text: reply.reply,
      at,
      state: 'taken',
      ...(revision ? { version: revision.version } : {}),
    });
  }
}

/** What a failed launch leaves with the visit: its cost, the model host that did not answer, or the answer's errors. */
function keptOf(error: unknown, result: LaunchResult | null) {
  if (error instanceof ModelHostUnavailable) {
    return { result: error.result, rest: { hostWait: error, answerErrors: null } };
  }
  if (error instanceof ResultInvalid) {
    return { result: error.result ?? result, rest: { hostWait: null, answerErrors: error.errors } };
  }
  return { result, rest: { hostWait: null, answerErrors: null } };
}

/** The plan result with the whole task list of the merged graph, as the planner writes tasks. */
function withTasksOf(result: PlanResult, tasks: Subtask[]): PlanResult {
  return {
    ...result,
    tasks: tasks.map(({ id, title, depends, files, proof, description, covers }) => ({
      id,
      title,
      depends,
      files,
      proof,
      description,
      covers,
    })),
  };
}
