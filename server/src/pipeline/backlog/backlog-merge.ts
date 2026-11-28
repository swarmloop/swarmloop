import { Injectable } from '@nestjs/common';
import type { MergeOutcome } from '../../contract/run-state';
import { BacklogRepository, type BacklogTaskRecord } from '../../history/backlog.repository';
import { DocumentRepository } from '../../history/document.repository';
import type { RunEntity } from '../../history/entities';
import { RunRepository } from '../../history/run.repository';
import { storedState, readOutcome } from '../../history/run-state';
import { MergeLanding } from '../../steps/shared/merge-landing';
import { RepositoryHost } from '../../steps/shared/repository-host';
import { RepositoryOrigins } from '../../steps/shared/repository-origins';
import { parseMergeRequests } from '../../steps/merge-request/merge-request-record';
import { deliveryOf, toPublish } from '../../steps/contract/delivery-list';
import { storedDelivery } from '../run-delivery';
import { parsePipelineRefs } from '../../steps/pipeline/pipeline-report';
import { CommandService } from '../command.service';
import { BacklogEvents } from './backlog-events';
import { mainWaitFor, readMains } from './main-readings';
import { tryNote } from './try-note';
import { CLOSED_NOTE } from '../../steps/shared/merge-rules';
import type { LandingQueue } from '../../steps/shared/merge-landing';
import type { MainReading } from './task-readiness';

type Backlog = Awaited<ReturnType<BacklogRepository['listBacklogs']>>[number];

/** How a task's pass ended: merged whole, its run asked to rebase, or held. */
type Settled = 'merged' | 'rebased' | 'held';

const NO_REQUEST_NOTE = 'its run is done without a merge request; needs a person';

/** What a rebase of the run answers to the landing: whether something was sent, and the note that says what. */
interface Sent {
  sent: boolean;
  note: string;
}

/** What the host reads of one request: its repository, the run's branch, its head and how it is out of line with main. */
interface Seen {
  repository: string;
  branch: string;
  head: string;
  word: string;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Follows the done runs of the backlogs' tasks to main, as the queue runner does: reads each merge request's gate,
 * merges through the one landing or says what holds it. A task's merged commit is kept per repository as soon as it is merged.
 */
@Injectable()
export class BacklogMerge {
  constructor(
    private readonly backlogs: BacklogRepository,
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly origins: RepositoryOrigins,
    private readonly host: RepositoryHost,
    private readonly commands: CommandService,
    private readonly events: BacklogEvents,
    private readonly landing: MergeLanding,
  ) {}

  /** One pass over every task with a run key of the backlogs that are not paused. `mains` is the tick's cache of repository mains. */
  async run(backlogs: Backlog[], mains: Map<string, MainReading>): Promise<void> {
    for (const backlog of backlogs.filter((found) => !found.paused)) {
      // The repositories an earlier task still has to merge into, by the slug of that task.
      const held = new Map<string, string>();
      for (const task of await this.backlogs.tasks(backlog.id as number)) {
        if (task.runKey === null || task.status === 'skipped') continue;
        if (task.repositories.every((repo) => repo in task.merged)) continue;
        await this.follow(backlog, task, mains, held);
      }
    }
  }

  private async follow(
    backlog: Backlog,
    task: BacklogTaskRecord,
    mains: Map<string, MainReading>,
    held: Map<string, string>,
  ): Promise<void> {
    const run = await this.runs.findRun(task.runKey as string);
    if (!run) return;
    try {
      const { state } = storedState(run);
      if (state === 'merged') await this.adopt(task, run, readOutcome(run.mergeOutcome));
      else if (state === 'closed') await this.save(task, { note: CLOSED_NOTE });
      else if (state !== 'done') await this.save(task, { note: '' });
      else await this.merge(backlog, task, run, mains, held);
    } catch (error) {
      await this.save(task, { note: tryNote(error) });
    }
  }

  /** A run MergeWatch saw merged: the task is merged with the commits of the run's outcome. */
  private async adopt(task: BacklogTaskRecord, run: RunEntity, outcome: MergeOutcome | null): Promise<void> {
    const facts = outcome && 'merged' in outcome ? outcome.merged : {};
    const merged = { ...task.merged };
    for (const repo of task.repositories) {
      const fact = facts[(await this.origins.of(repo)).project];
      if (fact) merged[repo] = fact.sha ?? '';
    }
    const body = (await this.documents.latestBody(run.key, 'merge_request')) ?? '';
    await this.landing.adopt(run, merged, (await this.requestsOf(run, body, Object.keys(merged))).requests);
    await this.save(task, { status: 'merged', merged, note: '' });
    await this.events.taskMerged(task.backlogId, task.slug);
  }

  /** Merges what the task can; a task that does not reach its main holds the repositories it still has to merge into. */
  private async merge(
    backlog: Backlog,
    task: BacklogTaskRecord,
    run: RunEntity,
    mains: Map<string, MainReading>,
    held: Map<string, string>,
  ): Promise<void> {
    const body = await this.documents.latestBody(run.key, 'merge_request');
    // The repositories the run publishes; a read one is never looked up, noted or merged.
    const publishing = toPublish(deliveryOf(await storedDelivery(this.documents, run.key), task.repositories));
    const repositories = publishing.map((entry) => entry.repo).filter((repo) => !(repo in task.merged));
    // What the task has merged so far in this pass, kept up to date by the landing, also when the pass ends on an error.
    const progress = { merged: task.merged };
    let settled: Settled = 'held';
    try {
      settled = await this.settle(
        backlog,
        task,
        run,
        { body, repositories, publishes: publishing.length > 0, progress },
        mains,
        held,
      );
    } finally {
      if (settled === 'held') {
        for (const repo of repositories) {
          if (!(repo in progress.merged) && !held.has(repo)) held.set(repo, task.slug);
        }
      }
    }
  }

  private async settle(
    backlog: Backlog,
    task: BacklogTaskRecord,
    run: RunEntity,
    {
      body,
      repositories,
      publishes,
      progress,
    }: {
      body: string | null;
      repositories: string[];
      publishes: boolean;
      progress: { merged: Record<string, string> };
    },
    mains: Map<string, MainReading>,
    held: Map<string, string>,
  ): Promise<Settled> {
    if (!body || !publishes) {
      await this.save(task, { note: NO_REQUEST_NOTE });
      return 'held';
    }
    const earlier = repositories.map((repo) => held.get(repo)).find((slug) => slug !== undefined);
    if (earlier !== undefined) {
      await this.save(task, { note: `waits for ${earlier} to merge first` });
      return 'held';
    }
    const { requests, notes } = await this.requestsOf(run, body, repositories);
    if (requests.length === 0 && notes.length > 0) {
      await this.save(task, { note: notes.join('; ') });
      return 'held';
    }
    await readMains(
      this.host,
      requests.map((request) => request.repo),
      backlog.owner,
      mains,
    );
    // The requests merged in an earlier pass go along: the landing reads the head of each to record the files.
    const earlierRequests = (await this.requestsOf(run, body, Object.keys(task.merged))).requests;
    let current = task;
    const landing = await this.landing.land({
      hostRun: run,
      run,
      title: task.title,
      requests: [...earlierRequests, ...requests],
      merged: task.merged,
      queue: {
        target: (repo) => ({
          kind: 'main',
          mode: backlog.mergeMode,
          manual: task.manual,
          mergeOk: task.mergeOk,
          mainWait: mainWaitFor(repo, mains.get(repo), task.fixesMain === repo),
        }),
        behind: () => Promise.resolve(false),
        rebase: (request, head) => this.rebase(backlog, task, run, request, head, mains),
        refused: async (request, head, message) => {
          await this.events.mergeRefused(backlog.id as number, {
            task: task.slug,
            repository: request.repo,
            head,
            message,
          });
        },
        landed: async (repo, sha) => {
          current = await this.save(current, { merged: { ...current.merged, [repo]: sha } });
          progress.merged = current.merged;
          mains.set(repo, { state: 'pending' });
        },
      },
    });
    if (landing.kind === 'merged' && notes.length === 0) {
      await this.save(current, { status: 'merged', note: '' });
      await this.events.taskMerged(task.backlogId, task.slug);
      return 'merged';
    }
    const holds = landing.kind === 'held' ? landing.holds : [];
    await this.save(current, { note: [...holds.map((hold) => hold.note), ...notes].join('; ') });
    // A task that sent its run a rebase is running again and holds nothing.
    return holds.some((hold) => hold.kind === 'rebased') ? 'rebased' : 'held';
  }

  /** The requests of the run in the repositories still to merge, and the notes of those it cannot merge yet. */
  private async requestsOf(run: RunEntity, body: string, repositories: string[]) {
    const refs = parsePipelineRefs((await this.documents.latestBody(run.key, 'pipeline_ref')) ?? '');
    const lines = parseMergeRequests(body);
    const requests: { repo: string; project: string; iid: number; branch: string }[] = [];
    const notes: string[] = [];
    for (const repo of repositories) {
      const { project } = await this.origins.of(repo);
      const line = lines.find((found) => found.project === project);
      const branch = refs.find((ref) => ref.project === project)?.ref;
      if (!line) notes.push(`no merge request for ${repo}; needs a person`);
      else if (!branch) notes.push(`waits for the branch of ${repo} to be known`);
      else requests.push({ repo, project, iid: line.iid, branch });
    }
    return { requests, notes };
  }

  /**
   * Moves the run onto main's tip, once per main head. When that move already ran and the host still reads the request
   * as behind or conflicting, its implement agent gets the conflict; so does a request the host refuses to merge as a
   * conflict. Sent says whether something went to the run; the note says what was sent or what is waited for.
   */
  private async rebase(
    backlog: Backlog,
    task: BacklogTaskRecord,
    run: RunEntity,
    request: Parameters<LandingQueue['rebase']>[0],
    head: string,
    mains: Map<string, MainReading>,
  ): Promise<Sent> {
    const seen = { repository: request.repo, branch: request.branch, head };
    const { mergeability } = await this.host.gate(run, request, request.branch);
    // A request the host reads as clean was refused by its merge: a conflict, which a move onto main has not cleared.
    if (mergeability === 'clean') return this.handConflict(backlog, task, run, { ...seen, word: 'conflicting' });
    const reading = mains.get(request.repo);
    const main = reading && 'head' in reading ? reading.head : undefined;
    if (!main) return { sent: false, note: `waits for the head of ${request.branch}` };
    const key = `backlog-rebase-${task.slug}-${main}`;
    const moved = await this.send(backlog, task, run, { key, payload: {}, head });
    if ('refused' in moved) return { sent: false, note: moved.refused };
    if (!moved.replayed) return { sent: true, note: `rebased onto ${request.branch}; waits for its new head` };
    return this.handConflict(backlog, task, run, { ...seen, word: mergeability });
  }

  /** Hands the conflict the host reports to the run's implement agent, once per request head. */
  private async handConflict(backlog: Backlog, task: BacklogTaskRecord, run: RunEntity, seen: Seen): Promise<Sent> {
    const hostConflict = `${seen.repository} merge request is ${seen.word} with ${seen.branch}`;
    const key = `backlog-host-conflict-${task.slug}-${seen.head}`;
    const handed = await this.send(backlog, task, run, { key, payload: { hostConflict }, head: seen.head });
    if ('refused' in handed) return { sent: false, note: handed.refused };
    return handed.replayed
      ? { sent: false, note: 'waits for its implement agent to resolve the conflict' }
      : { sent: true, note: 'handed its conflict to its implement agent' };
  }

  /** Sends one rebase of the run: whether it was a repeat, or the note of its refusal, which is tried again on the next tick. */
  private async send(
    backlog: Backlog,
    task: BacklogTaskRecord,
    run: RunEntity,
    rebase: { key: string; payload: Record<string, unknown>; head: string },
  ): Promise<{ replayed: boolean } | { refused: string }> {
    try {
      const { replayed } = await this.commands.accept('rebase', run.key, rebase.payload, {
        idempotencyKey: rebase.key,
      });
      return { replayed };
    } catch (error) {
      await this.events.rebaseRefused(backlog.id as number, {
        task: task.slug,
        head: rebase.head,
        message: reasonOf(error),
      });
      return { refused: `rebase refused: ${reasonOf(error)}` };
    }
  }

  /** Stores what changed on a task; the task as stored. */
  private async save(task: BacklogTaskRecord, patch: Partial<BacklogTaskRecord>): Promise<BacklogTaskRecord> {
    const changed = Object.entries(patch).some(
      ([field, value]) => JSON.stringify(task[field as keyof BacklogTaskRecord]) !== JSON.stringify(value),
    );
    return changed ? this.backlogs.saveTask({ ...task, ...patch }) : task;
  }
}
