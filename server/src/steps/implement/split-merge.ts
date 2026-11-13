import { Injectable } from '@nestjs/common';
import type { Subtask } from '../../contract/subtask';
import type { RunEntity } from '../../history/entities';
import { FetchFailed, MergeConflict } from '../../core/swarmloop-error';
import type { CodeHost } from '../../integrations/code-host/code-host';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { SubtaskOps, type SubtaskMergeRequest } from '../shared/subtask-ops';
import { SplitRebase } from './split-rebase';

interface MergeOutcome {
  tasks: Subtask[];
  /** Why the host refused a merge for a reason other than a conflict. It blocks the parent. */
  refusal: string | null;
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
  ) {}

  /** The host the person who started the run talks to. */
  private async hostOf(parent: RunEntity): Promise<CodeHost> {
    return (await this.hosts.forRun(parent.startedBy, parent.codeHost)).byName(parent.codeHost);
  }

  async run(parent: RunEntity, tasks: Subtask[]): Promise<MergeOutcome> {
    let current = tasks;
    for (const queued of tasks.filter((item) => item.status === 'green')) {
      const task = current.find((item) => item.id === queued.id) ?? queued;
      if (task.status !== 'green') continue;
      const child = await this.subtasks.find(parent, task.id);
      const hasRequest = child && (await this.subtasks.mergeRequests(child)).length > 0;
      const moved = child && hasRequest ? await this.rebases.behind(parent, task, child) : null;
      if (moved) {
        current = current.map((item) => (item.id === task.id ? moved : item));
        continue;
      }
      const outcome = await this.merge(parent, task);
      if (!outcome) continue;
      const { done, refusal } = outcome;
      current = current.map((item) => (item.id === task.id ? done : item));
      if (done.status !== 'merged') {
        return { tasks: current, refusal };
      }
      current = await this.rebases.afterMerge(parent, current, done, Object.values(done.merged ?? {}).at(-1) ?? '');
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
        const seen = await (await this.hostOf(parent)).readMergeRequest(request.project, request.iid);
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
    await this.subtasks.recordMerged(child, merged);
    const branch = await this.subtasks.branchOf(child);
    for (const request of requests) {
      await (await this.hostOf(parent)).deleteBranch(request.project, branch);
    }
    await this.subtasks.fastForward(parent);
    return { done: { ...task, status: 'merged', merged, note: undefined }, refusal: null };
  }

  private async mergeOne(parent: RunEntity, request: SubtaskMergeRequest): Promise<string> {
    return (await (await this.hostOf(parent)).mergeMergeRequest(request.project, request.iid)).sha;
  }
}
