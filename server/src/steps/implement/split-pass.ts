import { ERROR_CODES } from '../../contract/error-codes';
import { HOST_RETRY_MS } from '../../integrations/http';
import { storedState } from '../../history/run-state';
import type { RunEntity } from '../../history/entities';
import type { AppConfig } from '../../config/env';
import type { Clock } from '../../core/clock';
import type { DocumentRepository } from '../../history/document.repository';
import type { FlowRepository } from '../../history/flow.repository';
import type { VisitRepository } from '../../history/visit.repository';
import {
  readyTasks,
  settled,
  statusLine,
  runWaitNote,
  unmetDepends,
  waitNote,
  withStatuses,
  type Subtask,
} from '../../contract/subtask';
import { sampleSelf } from '../../history/visit';
import { openQuestions } from '../shared/answers';
import { keepOpen } from '../shared/question-parts';
import { renderQuestions } from '../research/research-record';
import type { SubtaskOps } from '../shared/subtask-ops';
import { mergedOf, taskStatusOf } from '../shared/subtask-status';
import type { StepContext } from '../base-step';
import type { StepResult } from '../contract/step-contract';
import { ARTIFACTS } from '../contract/artifacts';
import { handOver, settledRecord, settledView } from './split-handover';
import type { MergeLook } from './merge-look';
import type { SplitMerge } from './split-merge';
import { REBASED_PREFIX } from './split-rebase';
import type { SplitNeeds } from './split-needs';
import { SplitQuestions } from './split-questions';
import type { InboxPass, StarterInbox } from './starter-inbox';
import { gapOf, gapReturn, takeGap } from './review-gaps';
import { earliestRetry } from './subtask-retry';

const BLOCKED_ACTION = 'Resume, Replay or Skip task clears it';

function blockedNames(blocked: Subtask[]): string {
  return blocked.map((task) => `subtask ${task.id} is blocked`).join('; ');
}

export const NO_CI_NOTE = 'no CI on the feature branch';

/** What one pass over the task graph reads and writes through. */
interface SplitPassDeps {
  subtasks: SubtaskOps;
  merges: SplitMerge;
  needs: SplitNeeds;
  inbox: StarterInbox;
  documents: DocumentRepository;
  look: MergeLook;
  clock: Clock;
  config: AppConfig;
  flows: FlowRepository;
  visits: VisitRepository;
}

/** One scheduling pass of a split run's implement: answers, merges, starts what is ready and says what the parent waits for. */
export class SplitPass {
  private readonly questions: SplitQuestions;

  constructor(private readonly deps: SplitPassDeps) {
    this.questions = new SplitQuestions(deps.subtasks);
  }

  async run(subtasks: Subtask[], ctx: StepContext): Promise<StepResult> {
    const { run, startedAt } = ctx.opened;
    // Every task settled: the agent resolves a conflict of the parent's own edits, so it is parked for the agent.
    const view = await settledView(this.deps.subtasks, run, withStatuses(subtasks));
    const own = await this.deps.subtasks.commitOwnEdits(run, view !== null);
    if (own.conflict) {
      if (view) {
        await this.closeSkipped(run, withStatuses(subtasks), view);
        return handOver(ctx, view, { ...own, conflict: own.conflict }, subtasks);
      }
      const reason = `${startedAt} ${own.conflict}; the implement agent resolves it once every task is settled; a Resume or a message then goes on`;
      const text = [reason, own.committed].filter(Boolean).join('; ');
      return {
        route: { to: 'block', reason, code: ERROR_CODES.PARENT_TREE_CONFLICT },
        summary: text,
        outputs: [],
      };
    }
    const before = JSON.stringify(withStatuses(subtasks));
    const read = (await ctx.reread(ARTIFACTS.contract)) ?? '';
    const asked = (await ctx.reread(ARTIFACTS.subtaskQuestions)) ?? '';
    const answers = (await ctx.reread(ARTIFACTS.answers)) ?? '';
    const delivered = await this.questions.deliver(run, read, asked, answers, startedAt);
    const held = this.questions.pending(delivered.body, answers);
    const answered = await this.deps.inbox.take(ctx, withStatuses(subtasks), delivered.contract, held);
    const gapped = await this.gaps(ctx, answered);
    const needed = await this.deps.needs.run(ctx.opened, gapped.tasks, gapped.contract, held);
    const carried = openQuestions(delivered.body, []);
    const asks = [...gapped.asks, ...needed.asks];
    const open = [...carried, ...asks.map((ask) => ask.question)];
    const questions = renderQuestions(open);
    const storedParts = (await ctx.reread(ARTIFACTS.questionParts)) ?? [];
    const parts = keepOpen(storedParts, carried, asks);
    const followed = await this.refresh(run, needed.tasks);
    const { tasks: merged, refusal, unfetched, unmoved: mergeNote } = await this.deps.merges.run(run, followed.tasks);
    const unmoved = [followed.unmoved, mergeNote].filter(Boolean).join('; ') || null;
    const requirements = (await ctx.reread(ARTIFACTS.requirementList)) ?? [];
    const looked = await this.deps.look.run(ctx, merged, needed.contract, requirements);
    const tasks = await this.explain(run, await this.start(run, looked.tasks));
    const taken =
      gapped.taken === null ? [] : [{ artifact: ARTIFACTS.starterTaken, value: JSON.stringify(gapped.taken) }];
    const outputs: StepResult['outputs'] = [
      ...(JSON.stringify(tasks) === before ? [] : [{ artifact: ARTIFACTS.subtasks, value: tasks }]),
      ...(looked.contract === read ? [] : [{ artifact: ARTIFACTS.contract, value: looked.contract }]),
      ...(looked.looks === null ? [] : [{ artifact: ARTIFACTS.mergeLook, value: looked.looks }]),
      ...(questions === asked ? [] : [{ artifact: ARTIFACTS.subtaskQuestions, value: questions }]),
      ...(JSON.stringify(parts) === JSON.stringify(storedParts)
        ? []
        : [{ artifact: ARTIFACTS.questionParts, value: parts }]),
      ...taken,
    ];
    await this.closeSkipped(run, withStatuses(subtasks), tasks);
    const result = await this.route(ctx, tasks, open, outputs, { refusal, unfetched });
    const noted = unmoved ? this.withUnmoved(result, unmoved) : result;
    return own.committed ? { ...noted, summary: `${noted.summary}; ${own.committed}` } : noted;
  }

  /** The open merge requests of a task this pass marked skipped are closed. A merged request stays as it is. */
  private async closeSkipped(parent: RunEntity, stored: Subtask[], next: Subtask[]): Promise<void> {
    for (const task of next.filter((item) => item.status === 'skipped')) {
      if (stored.find((item) => item.id === task.id)?.status === 'skipped') continue;
      const child = await this.deps.subtasks.find(parent, task.id);
      if (child) await this.deps.subtasks.closeMergeRequests(parent, child);
    }
  }

  /**
   * Once every task is settled, a final review that marks requirements partial or missing becomes a task of the list,
   * and the review is taken, so the parent's own implement does not get it.
   */
  private async gaps(ctx: StepContext, answered: InboxPass): Promise<InboxPass> {
    const { run, startedAt } = ctx.opened;
    const stored = answered.taken ?? (JSON.parse((await ctx.reread(ARTIFACTS.starterTaken)) || '[]') as string[]);
    const gap = answered.tasks.every(settled) ? await gapOf(this.deps.documents, run.key, stored) : null;
    if (!gap) return answered;
    const requirements = (await ctx.reread(ARTIFACTS.requirementList)) ?? [];
    const gapped = takeGap(
      { contract: answered.contract, tasks: answered.tasks, requirements },
      gap,
      stored,
      startedAt,
    );
    await this.deps.subtasks.recordRevisions(run, gapped.changes, startedAt);
    return {
      contract: gapped.contract,
      tasks: gapped.tasks,
      asks: [...answered.asks, ...gapped.asks],
      taken: [...stored, gap.key, await gapReturn(this.deps.documents, run.id, gap), ...gapped.noted],
    };
  }

  /** The note of a worktree that kept its commits goes into the summary, and into the reason of a wait or a block. */
  private withUnmoved(result: StepResult, unmoved: string): StepResult {
    const { route } = result;
    const noted =
      route.to === 'wait' || route.to === 'block' ? { ...route, reason: `${route.reason}; ${unmoved}` } : route;
    return { ...result, route: noted, summary: `${result.summary}; ${unmoved}` };
  }

  /** What the parent does after the pass: wait with the reason, block, or finish when every task is settled. */
  private async route(
    ctx: StepContext,
    tasks: Subtask[],
    open: string[],
    outputs: StepResult['outputs'],
    { refusal, unfetched }: { refusal: string | null; unfetched: string | null },
  ): Promise<StepResult> {
    const { run, startedAt } = ctx.opened;
    const line = [statusLine(tasks), await this.waitLine(run, tasks)].filter(Boolean).join('; ');
    const blocked = tasks.filter((task) => task.status === 'blocked');
    const action = blocked.length > 0 ? `${blockedNames(blocked)}; ${BLOCKED_ACTION}` : null;
    if (unfetched && !tasks.some((task) => task.status === 'running')) {
      const retryAt = new Date(this.deps.clock.now() + HOST_RETRY_MS).toISOString();
      const text = `${line}; ${unfetched}; next try at ${retryAt}${action ? `; ${action}` : ''}`;
      return {
        route: { to: 'wait', reason: text, code: ERROR_CODES.HOST_UNAVAILABLE, retryAt },
        summary: `${startedAt} ${text}`,
        outputs,
      };
    }
    if ((blocked.length > 0 || refusal) && !this.canMove(tasks, refusal)) {
      const text = `${startedAt} ${refusal ?? blockedNames(blocked)}: ${line}${blocked.length > 0 ? `; ${BLOCKED_ACTION}` : ''}`;
      return { route: { to: 'block', reason: text, code: ERROR_CODES.SUBTASK_BLOCKED }, summary: text, outputs };
    }
    if (tasks.every(settled) && open.length === 0) {
      return this.finish(run, tasks, ctx, outputs);
    }
    if (open.length > 0) {
      const text = `questions are open: ${open[0]}`;
      return { route: { to: 'wait', reason: 'questions are open' }, summary: `${startedAt} ${text}`, outputs };
    }
    const retryAt = earliestRetry(await this.openChildren(run, tasks));
    if (retryAt) {
      const text = `${line}; next try at ${retryAt}${action ? `; ${action}` : ''}`;
      return {
        route: { to: 'wait', reason: text, code: ERROR_CODES.SUBTASK_WAITING, retryAt },
        summary: `${startedAt} ${text}`,
        outputs,
      };
    }
    const running = tasks.some((task) => task.status === 'running');
    const waiting = running ? null : this.missing(tasks);
    const code = waiting ? ERROR_CODES.SUBTASK_WAITING : ERROR_CODES.SUBTASKS_RUNNING;
    const text = `${waiting ? `${line} · waiting for ${waiting}` : line}${action ? `; ${action}` : ''}`;
    return { route: { to: 'wait', reason: text, code }, summary: `${startedAt} ${text}`, outputs };
  }

  /** What the running tasks whose own run waits wait on, for the parent's status line. */
  private async waitLine(parent: RunEntity, tasks: Subtask[]): Promise<string> {
    const notes: string[] = [];
    for (const task of tasks.filter((item) => item.status === 'running')) {
      const child = await this.deps.subtasks.find(parent, task.id);
      const { state, reason } = child ? storedState(child) : { state: 'running' as const, reason: null };
      const note = runWaitNote(task, { state, stateReason: reason });
      if (note) notes.push(note);
    }
    return notes.join('; ');
  }

  /** True when a task runs, or a green one is still to merge: the parent waits, and is blocked only when nothing can move. */
  private canMove(tasks: Subtask[], refusal: string | null): boolean {
    return tasks.some((task) => task.status === 'running' || (task.status === 'green' && !refusal));
  }

  private async openChildren(parent: RunEntity, tasks: Subtask[]): Promise<RunEntity[]> {
    const children: RunEntity[] = [];
    for (const task of tasks.filter((item) => !settled(item))) {
      const child = await this.deps.subtasks.find(parent, task.id);
      if (child) children.push(child);
    }
    return children;
  }

  /** Every task has a run, and its status follows that run. A settled task keeps the status it has. */
  private async refresh(parent: RunEntity, tasks: Subtask[]): Promise<{ tasks: Subtask[]; unmoved: string | null }> {
    const refreshed: Subtask[] = [];
    let taken = false;
    for (const task of tasks) {
      const followed = settled(task) ? task : await this.follow(parent, task);
      // A task an earlier pass merged and recorded never reaches the merge queue, so the worktree of the parent follows here.
      taken ||= !settled(task) && followed.status === 'merged';
      refreshed.push(followed);
    }
    return { tasks: refreshed, unmoved: taken ? await this.deps.subtasks.fastForward(parent) : null };
  }

  private async follow(parent: RunEntity, task: Subtask): Promise<Subtask> {
    const child = await this.deps.subtasks.open(parent, task);
    const { state, reason } = storedState(child);
    if (state === 'stopped') {
      // A Stop of the parent stopped this run. Resume goes on where it stopped.
      await this.deps.subtasks.resume(child);
    }
    const delivered = child.status === 'done' ? await this.deps.subtasks.deliveredNote(child) : null;
    if (delivered) return { ...task, status: 'skipped', note: delivered };
    const status = taskStatusOf(task, child);
    if (status === 'merged') return { ...task, status, merged: mergedOf(child), note: undefined };
    const waits = status === 'running' ? runWaitNote(task, { state, stateReason: reason }) : undefined;
    if (waits) return { ...task, status, note: waits };
    const rebased = status !== 'green' && task.note?.startsWith(REBASED_PREFIX) ? task.note : undefined;
    const note = status === 'green' && (await this.deps.subtasks.withoutCi(child)) ? NO_CI_NOTE : rebased;
    return { ...task, status, note };
  }

  /** The tasks that may run at once. A task that waits for a sibling holds no slot, or the sibling could never start. */
  async slots(parent: RunEntity, tasks: Subtask[]): Promise<number> {
    return this.deps.config.env.SUBTASKS_PARALLEL + (await this.deps.needs.waiting(parent, tasks));
  }

  /** Starts the tasks whose dependencies are merged or skipped, up to `SUBTASKS_PARALLEL` at a time. */
  private async start(parent: RunEntity, tasks: Subtask[]): Promise<Subtask[]> {
    const ready = readyTasks(tasks, await this.slots(parent, tasks)).map((task) => task.id);
    for (const task of tasks.filter((item) => ready.includes(item.id))) {
      await this.deps.subtasks.launch(parent, task);
    }
    return tasks.map((task) => (ready.includes(task.id) ? { ...task, status: 'running', note: undefined } : task));
  }

  /** What a waiting task waits for, on the task and on its run. */
  private async explain(parent: RunEntity, tasks: Subtask[]): Promise<Subtask[]> {
    const explained: Subtask[] = [];
    for (const task of tasks) {
      if (task.status !== 'waiting') {
        explained.push(task);
        continue;
      }
      const note = waitNote(task, tasks);
      const child = await this.deps.subtasks.find(parent, task.id);
      if (child) await this.deps.subtasks.waitFor(child, note);
      explained.push({ ...task, note });
    }
    return explained;
  }

  /** The tasks that hold up the waiting ones, when nothing runs yet. */
  private missing(tasks: Subtask[]): string | null {
    const unmet = new Set(
      tasks.filter((task) => task.status === 'waiting').flatMap((task) => unmetDepends(task, tasks)),
    );
    return unmet.size > 0 ? [...unmet].join(', ') : null;
  }

  /**
   * Every task is merged or skipped: the checks run on the feature branch. The flow keeps its implementation phase,
   * so a later return of the parent's own implement goes on to implement-improve. Only this merge visit skips it.
   */
  private async finish(
    run: RunEntity,
    tasks: Subtask[],
    ctx: StepContext,
    outputs: StepResult['outputs'],
  ): Promise<StepResult> {
    const active = await this.deps.flows.activePhases(run.id);
    const next = active.includes('checks') ? 'checks' : 'code-review';
    await this.deps.flows.noteFlow(
      run.key,
      next === 'checks' ? ['implementation', 'checks', 'code-review', 'ci'] : ['implementation', 'code-review', 'ci'],
      next,
    );
    await this.skipImprove(ctx);
    const record = settledRecord(tasks);
    return {
      route: { to: 'jump', step: next },
      summary: `${ctx.opened.startedAt} implement done\n${record.body.trimEnd()}`,
      outputs: [...outputs, ...record.outputs],
      handoff: `- ${statusLine(tasks)}\n`,
    };
  }

  private async skipImprove(ctx: StepContext): Promise<void> {
    const { run, startedAt, started } = ctx.opened;
    const finishedAt = this.deps.clock.iso();
    await this.deps.visits.finishVisit(run, {
      step: 'implement-improve',
      model: null,
      mode: null,
      startedAt,
      finishedAt,
      durationMs: this.deps.clock.now() - started,
      status: 'skipped',
      exitCode: 0,
      killReason: null,
      tokensIn: 0,
      tokensOut: 0,
      usd: 0,
      samples: [sampleSelf(finishedAt)],
      exchange: null,
      httpCalls: [],
      document: null,
      resumed: false,
    });
  }
}
