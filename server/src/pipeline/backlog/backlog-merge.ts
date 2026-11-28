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
import type { MainReading } from './task-readiness';

type Backlog = Awaited<ReturnType<BacklogRepository['listBacklogs']>>[number];

const NO_REQUEST_NOTE = 'its run is done without a merge request; needs a person';

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
      if (state === 'merged') await this.adopt(backlog, task, run, readOutcome(run.mergeOutcome));
      else if (state === 'closed') await this.save(task, { note: CLOSED_NOTE });
      else if (state !== 'done') await this.save(task, { note: '' });
      else await this.merge(backlog, task, run, mains, held);
    } catch (error) {
      await this.save(task, { note: tryNote(error) });
    }
  }

  /** A run MergeWatch saw merged: the task is merged with the commits of the run's outcome, and the host is asked nothing. */
  private async adopt(
    backlog: Backlog,
    task: BacklogTaskRecord,
    run: RunEntity,
    outcome: MergeOutcome | null,
  ): Promise<void> {
    const facts = outcome && 'merged' in outcome ? outcome.merged : {};
    const merged = { ...task.merged };
    for (const repo of task.repositories) {
      const fact = facts[(await this.origins.of(repo)).project];
      if (fact) merged[repo] = fact.sha ?? '';
    }
    await this.landing.adopt(run, merged, (repo) => this.host.defaultBranch(repo, backlog.owner));
    await this.save(task, { status: 'merged', merged, note: '' });
    await this.events.taskMerged(task.backlogId, task.slug);
  }

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
    if (!body || publishing.length === 0) return void (await this.save(task, { note: NO_REQUEST_NOTE }));
    const earlier = repositories.map((repo) => held.get(repo)).find((slug) => slug !== undefined);
    if (earlier !== undefined) return void (await this.save(task, { note: `waits for ${earlier} to merge first` }));
    const { requests, notes } = await this.requestsOf(run, body, repositories);
    if (requests.length === 0 && notes.length > 0) return void (await this.save(task, { note: notes.join('; ') }));
    await readMains(
      this.host,
      requests.map((request) => request.repo),
      backlog.owner,
      mains,
    );
    let current = task;
    const landing = await this.landing.land({
      hostRun: run,
      run,
      title: task.title,
      requests,
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
        rebase: (request, head) => this.rebase(backlog, task, run, request.branch, head),
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
          mains.set(repo, { state: 'pending' });
        },
        targetBranch: (repo) => this.host.defaultBranch(repo, backlog.owner),
      },
    });
    if (landing.kind === 'merged' && notes.length === 0) {
      await this.save(current, { status: 'merged', note: '' });
      await this.events.taskMerged(task.backlogId, task.slug);
      return;
    }
    const holds = landing.kind === 'held' ? landing.holds : [];
    await this.save(current, { note: [...holds.map((hold) => hold.note), ...notes].join('; ') });
    if (holds.some((hold) => hold.kind === 'rebased')) return;
    for (const repo of repositories) {
      if (!(repo in landing.merged) && !held.has(repo)) held.set(repo, task.slug);
    }
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

  /** Asks for a rebase of the run, once per head: null when this head was already asked, else whether it was sent, with the note. */
  private async rebase(
    backlog: Backlog,
    task: BacklogTaskRecord,
    run: RunEntity,
    branch: string,
    head: string,
  ): Promise<{ sent: boolean; note: string } | null> {
    try {
      const { replayed } = await this.commands.accept(
        'rebase',
        run.key,
        {},
        { idempotencyKey: `backlog-rebase-${task.slug}-${head}` },
      );
      return replayed ? null : { sent: true, note: `rebased onto ${branch}; waits for its new head` };
    } catch (error) {
      await this.events.rebaseRefused(backlog.id as number, { task: task.slug, head, message: reasonOf(error) });
      return { sent: false, note: `rebase refused: ${reasonOf(error)}` };
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
