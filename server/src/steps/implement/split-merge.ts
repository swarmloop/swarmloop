import { Injectable } from '@nestjs/common';
import type { Subtask } from '../../contract/subtask';
import type { RunEntity } from '../../history/entities';
import { FetchFailed, MergeConflict } from '../../core/swarmloop-error';
import type { CodeHost } from '../../integrations/code-host/code-host';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { mergeHow } from '../shared/merge-method';
import { RunNames } from '../shared/run-names';
import { SubtaskOps, type SubtaskMergeRequest } from '../shared/subtask-ops';
import { SplitRebase } from './split-rebase';

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
    private readonly hosts: CodeHostRegistry,
    private readonly rebases: SplitRebase,
    private readonly names: RunNames,
  ) {}

  /** The host the person who started the run talks to. */
  private hostOf(parent: RunEntity): Promise<CodeHost> {
    return this.hosts.hostFor(parent);
  }

  async run(parent: RunEntity, tasks: Subtask[]): Promise<MergeOutcome> {
    let current = tasks;
    const unmoved: string[] = [];
    const note = (): string | null => (unmoved.length > 0 ? unmoved.join('; ') : null);
    for (const queued of tasks.filter((item) => item.status === 'green')) {
      const task = current.find((item) => item.id === queued.id) ?? queued;
      if (task.status !== 'green') continue;
      const child = await this.subtasks.find(parent, task.id);
      const hasRequest = child && (await this.subtasks.mergeRequests(child)).length > 0;
      let moved: Subtask | null = null;
      try {
        moved = child && hasRequest ? await this.rebases.behind(parent, task, child) : null;
      } catch (error) {
        if (!(error instanceof FetchFailed)) throw error;
        return {
          tasks: current,
          refusal: null,
          unfetched: `subtask ${task.id} was not merged: ${error.message}`,
          unmoved: note(),
        };
      }
      if (moved) {
        current = current.map((item) => (item.id === task.id ? moved : item));
        continue;
      }
      const outcome = await this.merge(parent, task);
      if (!outcome) continue;
      const { done, refusal, unmoved: kept } = outcome;
      if (kept) unmoved.push(kept);
      current = current.map((item) => (item.id === task.id ? done : item));
      if (done.status !== 'merged') {
        return { tasks: current, refusal, unfetched: null, unmoved: note() };
      }
      current = await this.rebases.afterMerge(parent, current, done, Object.values(done.merged ?? {}).at(-1) ?? '');
    }
    return { tasks: current, refusal: null, unfetched: null, unmoved: note() };
  }

  /** Merges the requests of a task that no merge recorded yet, one repository after the other. Null for a task with no merge request. */
  private async merge(
    parent: RunEntity,
    task: Subtask,
  ): Promise<{ done: Subtask; refusal: string | null; unmoved: string | null } | null> {
    const child = await this.subtasks.find(parent, task.id);
    const requests = child ? await this.subtasks.mergeRequests(child) : [];
    if (!child || requests.length === 0) {
      return null;
    }
    const merged = { ...task.merged };
    try {
      for (const request of requests.filter((item) => !(item.repo in merged))) {
        const seen = await (await this.hostOf(parent)).readMergeRequest(request.project, request.iid);
        merged[request.repo] = seen.state === 'merged' ? (seen.sha ?? '') : await this.mergeOne(parent, request, task);
      }
    } catch (error) {
      if (error instanceof MergeConflict) {
        await this.subtasks.rebase(child);
        return { done: { ...task, merged, status: 'running' }, refusal: null, unmoved: null };
      }
      if (error instanceof FetchFailed) {
        return {
          done: { ...task, merged },
          refusal: `subtask ${task.id} was not merged: ${error.message}`,
          unmoved: null,
        };
      }
      throw error;
    }
    await this.subtasks.recordMerged(parent, child, merged);
    const branch = await this.subtasks.branchOf(child);
    for (const request of requests) {
      await (await this.hostOf(parent)).deleteBranch(request.project, branch);
    }
    const unmoved = await this.subtasks.fastForward(parent);
    return { done: { ...task, status: 'merged', merged, note: undefined }, refusal: null, unmoved };
  }

  /** Merges with the first method the repository allows and the title its format gives the task. */
  private async mergeOne(parent: RunEntity, request: SubtaskMergeRequest, task: Subtask): Promise<string> {
    const host = await this.hostOf(parent);
    const title = await this.names.taskTitle(parent, request.repo, task.title);
    const how = await mergeHow(host, request.project, title);
    return (await host.mergeMergeRequest(request.project, request.iid, undefined, how)).sha;
  }
}
