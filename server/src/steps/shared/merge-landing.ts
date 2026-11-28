import { Injectable } from '@nestjs/common';
import type { RunEntity } from '../../history/entities';
import { FetchFailed, MergeConflict } from '../../core/swarmloop-error';
import { decideMerge, type MergeFacts, type MergeTarget } from './merge-rules';
import { MergedFilesRecord } from './merged-files-record';
import { RepositoryHost } from './repository-host';

/** One merge request of an item, with the branch of the run in its repository. */
interface LandingRequest {
  repo: string;
  project: string;
  iid: number;
  branch: string;
}

/** What a queue gives the landing for its target branch: its readings and the writes that belong to the queue. */
export interface LandingQueue {
  target(repo: string): MergeTarget;
  /** Whether the target's own tip reading says the head is behind it. */
  behind(request: LandingRequest, head: string): Promise<boolean>;
  /** Asks for a rebase of the run. Sent false: nothing new was sent, a wait with the note. */
  rebase(request: LandingRequest, head: string): Promise<{ sent: boolean; note: string }>;
  /** The host refused the merge of this head. */
  refused(request: LandingRequest, head: string, message: string): Promise<void>;
  /** Keeps the commit of a repository at once. */
  landed(repo: string, sha: string): Promise<void>;
  /** The target branch of a repository, for reading what the merge changed. */
  targetBranch(repo: string): Promise<string>;
}

export interface LandingItem {
  /** The run whose host and title format are used: the parent for a child, the run itself for a backlog task. */
  hostRun: Parameters<RepositoryHost['merge']>[0];
  /** The run whose requests merge; its worktrees give the files. */
  run: RunEntity;
  title: string;
  requests: LandingRequest[];
  /** What is already merged, by repository. */
  merged: Record<string, string>;
  queue: LandingQueue;
}

interface Hold {
  repo: string;
  kind: 'wait' | 'person' | 'rebased' | 'refused';
  note: string;
}

export type Landing =
  { kind: 'merged'; merged: Record<string, string> } | { kind: 'held'; merged: Record<string, string>; holds: Hold[] };

type Step = { sha: string } | { hold: Omit<Hold, 'repo'> };

/**
 * The one place that merges a request. Both queues, the epic's split pass and the backlog's merge into main, offer
 * their items to it.
 *
 * Queue order, one rule per target branch: ready items are offered in queue order, and the first ready item that comes
 * back held with a 'wait', 'person' or 'refused' hold holds every later ready item of the same target branch for that
 * pass. An item that comes back 'rebased' runs again, so it is no longer ready and holds nothing. An item that is not
 * ready never holds.
 */
@Injectable()
export class MergeLanding {
  constructor(
    private readonly host: RepositoryHost,
    private readonly files: MergedFilesRecord,
  ) {}

  /**
   * Merges the requests of an item that are not merged yet, in order. A request held for a wait or a person does not stop
   * the others; a rebase that was sent does. The files of the merge are recorded before it returns merged.
   */
  async land(item: LandingItem): Promise<Landing> {
    const merged = { ...item.merged };
    const holds: Hold[] = [];
    for (const request of item.requests) {
      if (request.repo in merged) continue;
      const step = await this.landOne(item, request);
      if ('sha' in step) {
        merged[request.repo] = step.sha;
        await item.queue.landed(request.repo, step.sha);
        continue;
      }
      holds.push({ repo: request.repo, ...step.hold });
      if (step.hold.kind === 'rebased') break;
    }
    if (item.requests.every((request) => request.repo in merged)) {
      await this.files.record(item.run, merged, (repo) => item.queue.targetBranch(repo));
      return { kind: 'merged', merged };
    }
    return { kind: 'held', merged, holds };
  }

  /** Records the files of a merge the host already made; the host is asked nothing. */
  async adopt(
    run: RunEntity,
    merged: Record<string, string>,
    targetBranch: (repo: string) => Promise<string>,
  ): Promise<void> {
    await this.files.record(run, merged, targetBranch);
  }

  private async landOne(item: LandingItem, request: LandingRequest): Promise<Step> {
    const { queue } = item;
    const gate = await this.host.gate(item.hostRun, request, request.branch);
    const facts: MergeFacts = {
      gate,
      repository: request.repo,
      behind: await queue.behind(request, gate.head),
      target: queue.target(request.repo),
    };
    const decision = decideMerge(facts);
    if (decision.kind === 'rebase') return this.rebase(item, request, gate.head);
    if (decision.kind === 'merged') return { sha: decision.sha };
    if (decision.kind === 'merge') return this.merge(item, request, decision.head);
    return { hold: decision };
  }

  /** Asks for the rebase of a request that is behind; what the queue answers is a rebased hold or a wait. */
  private async rebase(item: LandingItem, request: LandingRequest, head: string): Promise<Step> {
    const sent = await item.queue.rebase(request, head);
    return { hold: { kind: sent.sent ? 'rebased' : 'wait', note: sent.note } };
  }

  /** Merges with the head as guard. A conflict is a request that is behind; a refusal of the host is held and told to the queue. */
  private async merge(item: LandingItem, request: LandingRequest, head: string): Promise<Step> {
    try {
      return { sha: await this.host.merge(item.hostRun, request.repo, item.title, request, head) };
    } catch (error) {
      if (error instanceof MergeConflict) return this.rebase(item, request, head);
      if (!(error instanceof FetchFailed)) throw error;
      await item.queue.refused(request, head, error.message);
      return { hold: { kind: 'refused', note: `merge refused by the host: ${error.message}` } };
    }
  }
}
