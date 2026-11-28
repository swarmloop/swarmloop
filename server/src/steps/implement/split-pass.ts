import { storedState } from '../../history/run-state';
import type { RunEntity } from '../../history/entities';
import type { AppConfig } from '../../config/env';
import type { Clock } from '../../core/clock';
import type { DocumentRepository } from '../../history/document.repository';
import type { FlowRepository } from '../../history/flow.repository';
import type { VisitRepository } from '../../history/visit.repository';
import { readyTasks, settled, runWaitNote, waitNote, withStatuses, type Subtask } from '../../contract/subtask';
import { openQuestions } from '../shared/answers';
import { askPerson, partsOfOpen, type PersonHeld } from '../shared/person-questions';
import type { StoredQuestion } from '../shared/question-parts';
import { renderQuestions } from '../research/research-record';
import type { OwnEdits, SubtaskOps } from '../shared/subtask-ops';
import { refusedRoute } from '../shared/start-refused';
import { withoutSkipped } from '../shared/subtask-question-line';
import { skippedByEpic } from '../shared/subtask-skip-reason';
import { mergedOf, moveNote, taskStatusOf } from '../shared/subtask-status';
import type { StepContext } from '../base-step';
import type { StepResult } from '../contract/step-contract';
import { ARTIFACTS } from '../contract/artifacts';
import { handOver, settledView } from './split-handover';
import type { MergeLook } from './merge-look';
import type { SplitMerge } from './split-merge';
import { REBASED_PREFIX } from './split-rebase';
import type { SplitNeeds } from './split-needs';
import { SplitQuestions } from './split-questions';
import { SplitRoute } from './split-route';
import type { InboxPass, StarterInbox } from './starter-inbox';
import { gapOf, gapReturn, takeGap } from './review-gaps';

export const NO_CI_NOTE = 'no CI on the feature branch';

/** The tasks `next` reads skipped that `stored` did not. */
function newlySkipped(stored: Subtask[], next: Subtask[]): Subtask[] {
  return next.filter(
    (task) => task.status === 'skipped' && stored.find((item) => item.id === task.id)?.status !== 'skipped',
  );
}

/** What a pass says of a conflict of the own edits that waits in the worktree while a task is open. */
function ownConflictNote(own: OwnEdits): string | null {
  return own.conflict ? `${own.conflict}; the implement agent resolves it once every task is settled` : null;
}

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
  private readonly routing: SplitRoute;

  constructor(private readonly deps: SplitPassDeps) {
    this.questions = new SplitQuestions(deps.subtasks);
    this.routing = new SplitRoute(deps);
  }

  async run(subtasks: Subtask[], ctx: StepContext): Promise<StepResult> {
    const { run, startedAt } = ctx.opened;
    // Every task settled: the agent resolves a conflict of the parent's own edits, so it is parked for the agent.
    const view = await settledView(this.deps.subtasks, run, withStatuses(subtasks));
    const own = await this.deps.subtasks.commitOwnEdits(run, view !== null);
    if (own.conflict && view) {
      await this.closeSkipped(run, newlySkipped(withStatuses(subtasks), view));
      return handOver(ctx, view, { ...own, conflict: own.conflict }, subtasks);
    }
    const stored = withStatuses(subtasks);
    // A task the list reads skipped may still hold open questions, its epic's copy among them: the one skip closes them.
    await this.closeSkipped(
      run,
      stored.filter((task) => task.status === 'skipped'),
    );
    const before = JSON.stringify(stored);
    const read = (await ctx.reread(ARTIFACTS.contract)) ?? '';
    const asked = (await ctx.reread(ARTIFACTS.subtaskQuestions)) ?? '';
    const answers = (await ctx.reread(ARTIFACTS.answers)) ?? '';
    const delivered = await this.questions.deliver(run, read, asked, answers, startedAt, stored);
    const held = this.questions.pending(delivered.body, answers);
    const answered = await this.deps.inbox.take(ctx, stored, delivered.contract, held);
    const gapped = await this.gaps(ctx, answered);
    const needed = await this.deps.needs.run(ctx.opened, gapped.tasks, gapped.contract, held);
    const followed = await this.refresh(run, needed.tasks);
    const { tasks: merged, refusal, unfetched, unmoved: mergeNote } = await this.deps.merges.run(run, followed.tasks);
    // A conflict of the own edits waits in the worktree, uncommitted, while a task is open: the pass goes on as with none.
    const unmoved = [followed.unmoved, mergeNote, ownConflictNote(own)].filter(Boolean).join('; ') || null;
    const requirements = (await ctx.reread(ARTIFACTS.requirementList)) ?? [];
    const looked = await this.deps.look.run(ctx, merged, needed.contract, requirements);
    // A refused look holds the dependents back: they start after the planner has seen the merge.
    const tasks = await this.explain(run, looked.refused ? looked.tasks : await this.start(run, looked.tasks));
    await this.closeSkipped(run, newlySkipped(stored, tasks));
    const carried = withoutSkipped(openQuestions(delivered.body, []), tasks);
    const asks = [...gapped.asks, ...needed.asks].filter((ask) => withoutSkipped([ask.question], tasks).length > 0);
    const storedParts = (await ctx.reread(ARTIFACTS.questionParts)) ?? [];
    const placed = await this.person(
      run,
      asks,
      {
        lines: carried,
        parts: partsOfOpen(storedParts, carried),
        answered: (await ctx.reread(ARTIFACTS.answeredQuestions)) ?? [],
      },
      { contract: looked.contract, at: startedAt },
    );
    const open = placed.lines;
    const questions = renderQuestions(open);
    const parts = placed.parts;
    const taken =
      gapped.taken === null ? [] : [{ artifact: ARTIFACTS.starterTaken, value: JSON.stringify(gapped.taken) }];
    const outputs: StepResult['outputs'] = [
      ...(JSON.stringify(tasks) === before ? [] : [{ artifact: ARTIFACTS.subtasks, value: tasks }]),
      ...(placed.contract === read ? [] : [{ artifact: ARTIFACTS.contract, value: placed.contract }]),
      ...(looked.looks === null ? [] : [{ artifact: ARTIFACTS.mergeLook, value: looked.looks }]),
      ...(questions === asked ? [] : [{ artifact: ARTIFACTS.subtaskQuestions, value: questions }]),
      ...(JSON.stringify(parts) === JSON.stringify(storedParts)
        ? []
        : [{ artifact: ARTIFACTS.questionParts, value: parts }]),
      ...taken,
    ];
    // The last task merged in this pass: the conflict is parked now, so the epic goes to implement and not to checks.
    const parked = await this.parkOwnEdits(
      ctx,
      { own, ready: !looked.refused && open.length === 0 },
      tasks,
      subtasks,
      outputs,
    );
    if (parked) return parked;
    const result = looked.refused
      ? { route: refusedRoute(looked.refused), summary: `${startedAt} ${looked.refused.message}`, outputs }
      : await this.routing.route(ctx, tasks, open, outputs, { refusal, unfetched });
    return this.noted(result, unmoved, own.committed);
  }

  /**
   * Puts each ask to the person through the one writer. An ask the person answered before is not put: its answer goes
   * down to its task in this pass, as a decision in the contract.
   */
  private async person(
    parent: RunEntity,
    asks: StoredQuestion[],
    start: PersonHeld,
    pass: { contract: string; at: string },
  ): Promise<PersonHeld & { contract: string }> {
    let held = start;
    let contract = pass.contract;
    for (const ask of asks) {
      const result = askPerson(held, ask);
      if (result.kind === 'asked') {
        held = { ...held, lines: result.lines, parts: result.parts };
        continue;
      }
      const taskId = (ask.parts.asker ?? '').replace(/^subtask:/, '');
      contract = await this.questions.handDown(parent, taskId, result.answer, pass.at, contract);
    }
    return { ...held, contract };
  }

  /**
   * A conflict of the own edits that waited while a task was open, and every task settled in this pass: the edits are
   * committed again with the conflict parked and handed to implement. Null when there is nothing to park or they now go on cleanly.
   */
  private async parkOwnEdits(
    ctx: StepContext,
    waiting: { own: OwnEdits; ready: boolean },
    tasks: Subtask[],
    stored: Subtask[],
    outputs: StepResult['outputs'],
  ): Promise<StepResult | null> {
    if (!waiting.own.conflict || !waiting.ready || !tasks.every(settled)) return null;
    const own = await this.deps.subtasks.commitOwnEdits(ctx.opened.run, true);
    if (!own.conflict) return null;
    const handed = handOver(ctx, tasks, { ...own, conflict: own.conflict }, stored);
    return { ...handed, outputs: [...outputs.filter((out) => out.artifact !== ARTIFACTS.subtasks), ...handed.outputs] };
  }

  /** The note of a worktree that kept its commits and the paths the own edits committed go into the summary. */
  private noted(result: StepResult, unmoved: string | null, committed: string | null): StepResult {
    const noted = unmoved ? this.routing.withUnmoved(result, unmoved) : result;
    return committed ? { ...noted, summary: `${noted.summary}; ${committed}` } : noted;
  }

  /** The run of each of these skipped tasks is closed with the epic's reason. A run already skipped only has its questions closed. */
  private async closeSkipped(parent: RunEntity, skipped: Subtask[]): Promise<void> {
    for (const task of skipped) {
      const child = await this.deps.subtasks.find(parent, task.id);
      if (child) await this.deps.subtasks.closeSkipped(parent, child, skippedByEpic(task.note));
    }
  }

  /**
   * Once every task is settled, a final review that marks requirements partial or missing becomes a task of the list,
   * and the review is taken, so the parent's own implement does not get it.
   */
  private async gaps(ctx: StepContext, answered: InboxPass): Promise<InboxPass> {
    const { run, startedAt } = ctx.opened;
    const stored = answered.taken ?? (JSON.parse((await ctx.reread(ARTIFACTS.starterTaken)) || '[]') as string[]);
    const gap = answered.tasks.every(settled)
      ? await gapOf(this.deps.documents, this.deps.subtasks, run, answered.tasks, stored)
      : null;
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
    // A run whose move has not run is not read: its worktrees and its state are those before the move.
    const moving = await this.deps.subtasks.moving(child);
    const delivered = !moving && child.status === 'done' ? await this.deps.subtasks.deliveredNote(child) : null;
    if (delivered) return { ...task, status: 'skipped', note: delivered };
    const move = await this.deps.subtasks.moveOf(child);
    const status = moving ? 'running' : taskStatusOf(task, child, move);
    if (status === 'merged') return { ...task, status, merged: mergedOf(child), note: undefined };
    if (move) return { ...task, status, note: moveNote(move) };
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
}
