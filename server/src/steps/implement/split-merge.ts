import { Injectable } from '@nestjs/common';
import type { Subtask } from '../../contract/subtask';
import type { RunEntity } from '../../history/entities';
import { FetchFailed } from '../../core/swarmloop-error';
import { MergeLanding, type Landing, type LandingQueue } from '../shared/merge-landing';
import { RepositoryHost } from '../shared/repository-host';
import { SubtaskOps } from '../shared/subtask-ops';
import { SplitRebase } from './split-rebase';

const MOVED_NOTE = 'rebased onto the epic: the feature branch moved on';

interface MergeOutcome {
  tasks: Subtask[];
  /** Why the host refused a merge for a reason other than a conflict. It blocks the parent. */
  refusal: string | null;
  /** Why a green task's branch could not be fetched to place it on the feature branch. It is a wait with a next try, never a refusal. */
  unfetched: string | null;
  /** What the worktree of the parent kept when it could not follow the feature branch: both heads. The merges stand. */
  unmoved: string | null;
}

/**
 * The merge queue of a pass: the green tasks merge into the feature branch one at a time, in task order. A merge
 * request never names its target here: it merges into the branch it was opened against, which is the feature branch
 * for every subtask. A task merges only when its last CI ran on top of the feature branch as it is now; a task
 * behind it is rebased and merges when its gates ran again. After a merge every task that conflicts is rebased.
 */
@Injectable()
export class SplitMerge {
  constructor(
    private readonly subtasks: SubtaskOps,
    private readonly landing: MergeLanding,
    private readonly host: RepositoryHost,
    private readonly rebases: SplitRebase,
  ) {}

  async run(parent: RunEntity, tasks: Subtask[]): Promise<MergeOutcome> {
    let current = tasks;
    const unmoved: string[] = [];
    const replace = (next: Subtask) => current.map((item) => (item.id === next.id ? next : item));
    const outcome = (stop: Pick<MergeOutcome, 'refusal' | 'unfetched'>): MergeOutcome => ({
      tasks: current,
      ...stop,
      unmoved: unmoved.length > 0 ? unmoved.join('; ') : null,
    });
    for (const queued of tasks.filter((item) => item.status === 'green')) {
      const task = current.find((item) => item.id === queued.id) ?? queued;
      if (task.status !== 'green') continue;
      const child = await this.subtasks.find(parent, task.id);
      const requests = child ? await this.subtasks.mergeRequests(child) : [];
      if (!child || requests.length === 0) continue;
      const branch = await this.subtasks.branchOf(child);
      let landing: Landing;
      try {
        landing = await this.landing.land({
          hostRun: parent,
          run: child,
          title: task.title,
          requests: requests.map((request) => ({ ...request, branch })),
          merged: task.merged ?? {},
          queue: this.queueOf(parent, child),
        });
      } catch (error) {
        if (!(error instanceof FetchFailed)) throw error;
        return outcome({ refusal: null, unfetched: `subtask ${task.id} was not merged: ${error.message}` });
      }
      if (landing.kind === 'merged') {
        const done = { ...task, status: 'merged' as const, merged: landing.merged, note: undefined };
        await this.subtasks.recordMerged(parent, child, landing.merged);
        for (const request of requests) await this.host.deleteBranch(parent, request.project, branch);
        const kept = await this.subtasks.fastForward(parent);
        if (kept) unmoved.push(kept);
        current = await this.rebases.afterMerge(
          parent,
          replace(done),
          done,
          Object.values(landing.merged).at(-1) ?? '',
        );
        continue;
      }
      const { holds } = landing;
      const held = { ...task, merged: landing.merged };
      const words = `subtask ${task.id} was not merged: ${holds.map((hold) => hold.note).join('; ')}`;
      if (holds.some((hold) => hold.kind === 'refused' || hold.kind === 'person')) {
        current = replace(held);
        return outcome({ refusal: words, unfetched: null });
      }
      if (holds.some((hold) => hold.kind === 'rebased')) {
        current = replace({ ...held, status: 'running', note: MOVED_NOTE });
        continue;
      }
      current = replace(held);
      return outcome({ refusal: null, unfetched: words });
    }
    return outcome({ refusal: null, unfetched: null });
  }

  /** The queue of the feature branch: the landing rebases a task that is behind it. */
  private queueOf(parent: RunEntity, child: RunEntity): LandingQueue {
    let tip: string | null = null;
    return {
      target: () => ({ kind: 'branch' }),
      behind: async () => {
        tip = await this.subtasks.behindTip(parent, child);
        return tip !== null;
      },
      rebase: async () => {
        const sent = await this.subtasks.rebase(child, tip ? { tip, note: MOVED_NOTE } : undefined);
        return sent ? { sent: true, note: MOVED_NOTE } : { sent: false, note: 'waits to be rebased onto the epic' };
      },
      refused: () => Promise.resolve(),
      // The landing hands back every commit it made, and the pass keeps them on the task.
      landed: () => Promise.resolve(),
      targetBranch: () => this.subtasks.branchOf(parent),
    };
  }
}
