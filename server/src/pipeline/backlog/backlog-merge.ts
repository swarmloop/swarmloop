import { Injectable } from '@nestjs/common';
import type { MergeOutcome } from '../../contract/run-state';
import { FetchFailed, MergeConflict } from '../../core/swarmloop-error';
import { BacklogRepository, type BacklogTaskRecord } from '../../history/backlog.repository';
import { DocumentRepository } from '../../history/document.repository';
import type { RunEntity } from '../../history/entities';
import { RunRepository } from '../../history/run.repository';
import { storedState, readOutcome } from '../../history/run-state';
import { RepositoryHost } from '../../steps/shared/repository-host';
import { RepositoryOrigins } from '../../steps/shared/repository-origins';
import { parseMergeRequests, type MergeRequestLine } from '../../steps/merge-request/merge-request-record';
import { deliveryOf, toPublish } from '../../steps/contract/delivery-list';
import { storedDelivery } from '../run-delivery';
import { parsePipelineRefs } from '../../steps/pipeline/pipeline-report';
import { CommandService } from '../command.service';
import { BacklogEvents } from './backlog-events';
import { readMains } from './main-readings';
import { tryNote } from './try-note';
import { CLOSED_NOTE, decideMerge, type MergeFacts } from './merge-rules';
import type { MainReading } from './task-readiness';

type Backlog = Awaited<ReturnType<BacklogRepository['listBacklogs']>>[number];

const NO_REQUEST_NOTE = 'its run is done without a merge request; needs a person';

/** One repository of a task and the request its run made there. */
interface Target {
  repository: string;
  request: MergeRequestLine;
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
 * rebases, merges or says what holds it. A task's merged commit is kept per repository as soon as it is merged.
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
  ) {}

  /** One pass over every task with a run key of the backlogs that are not paused. `mains` is the tick's cache of repository mains. */
  async run(backlogs: Backlog[], mains: Map<string, MainReading>): Promise<void> {
    for (const backlog of backlogs.filter((found) => !found.paused)) {
      for (const task of await this.backlogs.tasks(backlog.id as number)) {
        if (task.runKey === null || task.status === 'skipped') continue;
        if (task.repositories.every((repo) => repo in task.merged)) continue;
        await this.follow(backlog, task, mains);
      }
    }
  }

  private async follow(backlog: Backlog, task: BacklogTaskRecord, mains: Map<string, MainReading>): Promise<void> {
    const run = await this.runs.findRun(task.runKey as string);
    if (!run) return;
    try {
      const { state } = storedState(run);
      if (state === 'merged') await this.adopt(task, readOutcome(run.mergeOutcome));
      else if (state === 'closed') await this.save(task, { note: CLOSED_NOTE });
      else if (state !== 'done') await this.save(task, { note: '' });
      else await this.merge(backlog, task, run, mains);
    } catch (error) {
      await this.save(task, { note: tryNote(error) });
    }
  }

  /** A run MergeWatch saw merged: the task is merged with the commits of the run's outcome, and the host is not asked. */
  private async adopt(task: BacklogTaskRecord, outcome: MergeOutcome | null): Promise<void> {
    const facts = outcome && 'merged' in outcome ? outcome.merged : {};
    const merged = { ...task.merged };
    for (const repo of task.repositories) {
      const fact = facts[(await this.origins.of(repo)).project];
      if (fact) merged[repo] = fact.sha ?? '';
    }
    await this.save(task, { status: 'merged', merged, note: '' });
    await this.events.taskMerged(task.backlogId, task.slug);
  }

  private async merge(
    backlog: Backlog,
    task: BacklogTaskRecord,
    run: RunEntity,
    mains: Map<string, MainReading>,
  ): Promise<void> {
    const body = await this.documents.latestBody(run.key, 'merge_request');
    // The repositories the run publishes; a read one is never looked up, noted or merged.
    const publishing = toPublish(deliveryOf(await storedDelivery(this.documents, run.key), task.repositories));
    const repositories = publishing.map((entry) => entry.repo);
    if (!body || repositories.length === 0) return void (await this.save(task, { note: NO_REQUEST_NOTE }));
    const refs = parsePipelineRefs((await this.documents.latestBody(run.key, 'pipeline_ref')) ?? '');
    const requests = parseMergeRequests(body);
    let current = task;
    const notes: string[] = [];
    for (const repository of repositories) {
      if (repository in current.merged) continue;
      try {
        const project = (await this.origins.of(repository)).project;
        const request = requests.find((line) => line.project === project);
        if (!request) {
          notes.push(`no merge request for ${repository}; needs a person`);
          continue;
        }
        const branch = refs.find((ref) => ref.project === project)?.ref;
        if (!branch) {
          notes.push(`waits for the branch of ${repository} to be known`);
          continue;
        }
        const step = await this.step(backlog, current, run, { repository, request }, branch, mains);
        current = step.task;
        if (!(repository in current.merged)) notes.push(step.note);
      } catch (error) {
        notes.push(tryNote(error));
      }
    }
    if (!repositories.every((repo) => repo in current.merged)) {
      await this.save(current, { note: notes.join('; ') });
      return;
    }
    await this.save(current, { status: 'merged', note: '' });
    await this.events.taskMerged(task.backlogId, task.slug);
  }

  /** Reads one request's gate and acts on the rules' outcome. The task comes back as stored, with the note that says what holds it. */
  private async step(
    backlog: Backlog,
    task: BacklogTaskRecord,
    run: RunEntity,
    target: Target,
    branch: string,
    mains: Map<string, MainReading>,
  ): Promise<{ task: BacklogTaskRecord; note: string }> {
    const { repository, request } = target;
    await readMains(this.host, [repository], backlog.owner, mains);
    const facts: MergeFacts = {
      mode: backlog.mergeMode,
      manual: task.manual,
      mergeOk: task.mergeOk,
      gate: await this.host.gate(run, request, branch),
      repository,
      main: mains.get(repository),
      fixesMainHere: task.fixesMain === repository,
    };
    let decision = decideMerge(facts);
    if (decision.kind === 'rebase') {
      const seen = { repository, branch, head: facts.gate.head, word: facts.gate.mergeability };
      decision = { kind: 'wait', note: await this.rebase(backlog, task, run, seen, mains) };
    }
    if (decision.kind === 'merged') return this.record(task, repository, decision.sha);
    if (decision.kind === 'merge') return this.mergeRequest(backlog, task, run, target, decision.head, branch, mains);
    return { task, note: 'note' in decision ? decision.note : '' };
  }

  /** Merges with the head as guard and keeps the commit at once, so a partly merged task goes on with the rest on a later tick. */
  private async mergeRequest(
    backlog: Backlog,
    task: BacklogTaskRecord,
    run: RunEntity,
    { repository, request }: Target,
    head: string,
    branch: string,
    mains: Map<string, MainReading>,
  ): Promise<{ task: BacklogTaskRecord; note: string }> {
    try {
      const sha = await this.host.merge(run, repository, task.title, request, head);
      mains.set(repository, { state: 'pending' });
      return await this.record(task, repository, sha);
    } catch (error) {
      if (error instanceof MergeConflict) {
        const seen = { repository, branch, head, word: 'conflicting' };
        return { task, note: await this.handConflict(backlog, task, run, seen) };
      }
      if (!(error instanceof FetchFailed)) throw error;
      await this.events.mergeRefused(backlog.id as number, {
        task: task.slug,
        repository,
        head,
        message: error.message,
      });
      return { task, note: `merge refused by the host: ${error.message}` };
    }
  }

  /**
   * Moves the run onto main's tip, once per main head. When that move already ran and the host still reads the request
   * as behind or conflicting, its implement agent gets the conflict. The note says what was sent or what is waited for.
   */
  private async rebase(
    backlog: Backlog,
    task: BacklogTaskRecord,
    run: RunEntity,
    seen: Seen,
    mains: Map<string, MainReading>,
  ): Promise<string> {
    const reading = mains.get(seen.repository);
    const main = reading && 'head' in reading ? reading.head : undefined;
    if (!main) return `waits for the head of ${seen.branch}`;
    const key = `backlog-rebase-${task.slug}-${main}`;
    const sent = await this.send(backlog, task, run, { key, payload: {}, head: seen.head });
    if ('refused' in sent) return sent.refused;
    return sent.replayed
      ? this.handConflict(backlog, task, run, seen)
      : `rebased onto ${seen.branch}; waits for its new head`;
  }

  /** Hands the conflict the host reports to the run's implement agent, once per request head. */
  private async handConflict(backlog: Backlog, task: BacklogTaskRecord, run: RunEntity, seen: Seen): Promise<string> {
    const hostConflict = `${seen.repository} merge request is ${seen.word} with ${seen.branch}`;
    const key = `backlog-host-conflict-${task.slug}-${seen.head}`;
    const sent = await this.send(backlog, task, run, { key, payload: { hostConflict }, head: seen.head });
    if ('refused' in sent) return sent.refused;
    return sent.replayed
      ? 'waits for its implement agent to resolve the conflict'
      : 'handed its conflict to its implement agent';
  }

  /** Sends one rebase of the run: how it went, or the note of its refusal, which is tried again on the next tick. */
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

  private async record(task: BacklogTaskRecord, repository: string, sha: string) {
    const saved = await this.save(task, { merged: { ...task.merged, [repository]: sha } });
    return { task: saved, note: '' };
  }

  /** Stores what changed on a task; the task as stored. */
  private async save(task: BacklogTaskRecord, patch: Partial<BacklogTaskRecord>): Promise<BacklogTaskRecord> {
    const changed = Object.entries(patch).some(
      ([field, value]) => JSON.stringify(task[field as keyof BacklogTaskRecord]) !== JSON.stringify(value),
    );
    return changed ? this.backlogs.saveTask({ ...task, ...patch }) : task;
  }
}
