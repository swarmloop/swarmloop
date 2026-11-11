import { Injectable } from '@nestjs/common';
import { settled, type Subtask } from '../../contract/subtask';
import type { RunEntity } from '../../history/entities';
import { FetchFailed, MergeConflict } from '../../core/swarmloop-error';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { SubtaskOps, type SubtaskMergeRequest } from '../shared/subtask-ops';

interface MergeOutcome {
  tasks: Subtask[];
  /** Why the host refused a merge for a reason other than a conflict. It blocks the parent. */
  refusal: string | null;
}

/**
 * The merge stage of a pass: the green tasks merge into the feature branch one at a time, in task order. A merge
 * request never names its target here: it merges into the branch it was opened against, which is the feature branch
 * for every subtask. A task that conflicts is sent a Rebase and comes back green when its gates ran again.
 */
@Injectable()
export class SplitMerge {
  constructor(
    private readonly subtasks: SubtaskOps,
    private readonly hosts: CodeHostRegistry,
  ) {}

  async run(parent: RunEntity, tasks: Subtask[]): Promise<MergeOutcome> {
    let current = tasks;
    if (tasks.some((task) => task.status === 'blocked')) {
      return { tasks, refusal: null };
    }
    for (const task of tasks.filter((item) => item.status === 'green')) {
      const outcome = await this.merge(parent, task);
      if (!outcome) continue;
      const { done, refusal } = outcome;
      current = current.map((item) => (item.id === task.id ? done : item));
      if (done.status !== 'merged') {
        return { tasks: current, refusal };
      }
      await this.rebaseConflicting(parent, current);
    }
    return { tasks: current, refusal: null };
  }

  /** Merges the requests of a task that no merge recorded yet, one repository after the other. Null for a task with no merge request. */
  private async merge(parent: RunEntity, task: Subtask): Promise<{ done: Subtask; refusal: string | null } | null> {
    const child = await this.subtasks.find(parent, task.id);
    const requests = child ? await this.subtasks.mergeRequests(child) : [];
    if (!child || requests.length === 0) {
      return null;
    }
    const merged = { ...task.merged };
    try {
      for (const request of requests.filter((item) => !(item.repo in merged))) {
        const seen = await this.hosts.byName(parent.codeHost).readMergeRequest(request.project, request.iid);
        merged[request.repo] = seen.state === 'merged' ? (seen.sha ?? '') : await this.mergeOne(parent, request);
      }
    } catch (error) {
      if (error instanceof MergeConflict) {
        await this.subtasks.rebase(child);
        return { done: { ...task, merged, status: 'running' }, refusal: null };
      }
      if (error instanceof FetchFailed) {
        return { done: { ...task, merged }, refusal: `subtask ${task.id} was not merged: ${error.message}` };
      }
      throw error;
    }
    const branch = await this.subtasks.branchOf(child);
    for (const request of requests) {
      await this.hosts.byName(parent.codeHost).deleteBranch(request.project, branch);
    }
    await this.subtasks.fastForward(parent);
    return { done: { ...task, status: 'merged', merged, note: undefined }, refusal: null };
  }

  private async mergeOne(parent: RunEntity, request: SubtaskMergeRequest): Promise<string> {
    return (await this.hosts.byName(parent.codeHost).mergeMergeRequest(request.project, request.iid)).sha;
  }

  /** An open task whose merge request conflicts after a merge is sent a Rebase. A green one finds out when its own merge is refused. */
  private async rebaseConflicting(parent: RunEntity, tasks: Subtask[]): Promise<void> {
    for (const task of tasks.filter((item) => !settled(item) && item.status !== 'green')) {
      const child = await this.subtasks.find(parent, task.id);
      for (const request of child ? await this.subtasks.mergeRequests(child) : []) {
        if ((await this.hosts.byName(parent.codeHost).readMergeRequest(request.project, request.iid)).conflicts) {
          await this.subtasks.rebase(child as RunEntity);
          break;
        }
      }
    }
  }
}
