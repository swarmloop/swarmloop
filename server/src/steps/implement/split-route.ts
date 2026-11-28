import { ERROR_CODES } from '../../contract/error-codes';
import { nextTryAt } from '../../contract/outside-waits';
import { HOST_RETRY_MS } from '../../integrations/http';
import { storedState } from '../../history/run-state';
import type { RunEntity } from '../../history/entities';
import type { Clock } from '../../core/clock';
import type { FlowRepository } from '../../history/flow.repository';
import type { VisitRepository } from '../../history/visit.repository';
import { settled, statusLine, runWaitNote, unmetDepends, type Subtask } from '../../contract/subtask';
import { sampleSelf } from '../../history/visit';
import type { SubtaskOps } from '../shared/subtask-ops';
import type { StepContext } from '../base-step';
import type { StepResult } from '../contract/step-contract';
import { settledRecord } from './split-handover';
import { earliestRetry } from './subtask-retry';

const BLOCKED_ACTION = 'Resume, Replay or Skip task clears it';

function blockedNames(blocked: Subtask[]): string {
  return blocked.map((task) => `subtask ${task.id} is blocked${task.note ? `: ${task.note}` : ''}`).join('; ');
}

/** What the routing after a pass reads. */
interface SplitRouteDeps {
  subtasks: SubtaskOps;
  clock: Clock;
  flows: FlowRepository;
  visits: VisitRepository;
}

/** What the epic does after a pass: wait with the reason, block, or finish when every task is settled. */
export class SplitRoute {
  constructor(private readonly deps: SplitRouteDeps) {}

  /** The note of a worktree that kept its commits goes into the summary, and into the reason of a wait or a block. */
  withUnmoved(result: StepResult, unmoved: string): StepResult {
    const { route } = result;
    const noted =
      route.to === 'wait' || route.to === 'block' ? { ...route, reason: `${route.reason}; ${unmoved}` } : route;
    return { ...result, route: noted, summary: `${result.summary}; ${unmoved}` };
  }

  /** What the parent does after the pass: wait with the reason, block, or finish when every task is settled. */
  async route(
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
      const retryAt = nextTryAt(this.deps.clock.now(), HOST_RETRY_MS);
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
      httpCalls: [],
      document: null,
      resumed: false,
    });
  }
}
