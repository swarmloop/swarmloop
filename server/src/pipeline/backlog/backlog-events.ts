import { Injectable } from '@nestjs/common';
import { needsPerson } from '../../contract/run-state';
import { settled } from '../../contract/subtask';
import { BacklogRepository, type BacklogTaskRecord } from '../../history/backlog.repository';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { deriveState } from '../../history/run-state';
import { VisitRepository } from '../../history/visit.repository';
import { RepositoryHost } from '../../steps/shared/repository-host';
import { backlogProgress } from './backlog-progress';
import { heldBack } from './held-back';
import { readMains } from './main-readings';
import { backlogTasks, type MainReading, type RunFacts } from './task-readiness';

type Backlog = Awaited<ReturnType<BacklogRepository['listBacklogs']>>[number];

/**
 * Writes the events of the backlogs, each once per key: the ones the merge pass reports, and the ones one look at the tasks, the runs, the mains
 * and the requirements shows. A requirement's and a milestone's status change is written with its event in one transaction.
 */
@Injectable()
export class BacklogEvents {
  constructor(
    private readonly backlogs: BacklogRepository,
    private readonly runs: RunRepository,
    private readonly visits: VisitRepository,
    private readonly documents: DocumentRepository,
    private readonly host: RepositoryHost,
  ) {}

  taskMerged(backlogId: number, slug: string): Promise<boolean> {
    return this.backlogs.recordEvent(backlogId, `task-merged:${slug}`, 'task-merged', { slug });
  }

  mergeRefused(
    backlogId: number,
    facts: { task: string; repository: string; head: string; message: string },
  ): Promise<boolean> {
    const key = `merge-refused:${facts.task}:${facts.repository}:${facts.head}`;
    return this.backlogs.recordEvent(backlogId, key, 'merge-refused', facts);
  }

  rebaseRefused(backlogId: number, facts: { task: string; head: string; message: string }): Promise<boolean> {
    return this.backlogs.recordEvent(backlogId, `rebase-refused:${facts.task}:${facts.head}`, 'rebase-refused', facts);
  }

  /** One look at every backlog, paused or not, and every task with a run key whatever its milestone. `mains` is the tick's cache of repository mains. */
  async observe(backlogs: Backlog[], mains: Map<string, MainReading>): Promise<void> {
    for (const backlog of backlogs) {
      const id = backlog.id as number;
      const records = await this.backlogs.tasks(id);
      await this.observeRuns(id, records);
      await this.observeMains(backlog, records, mains);
      await this.observeProgress(id, records);
    }
  }

  private async observeRuns(backlogId: number, records: BacklogTaskRecord[]): Promise<void> {
    const milestones = await this.backlogs.milestones(backlogId);
    const active = new Set(milestones.filter((milestone) => milestone.status === 'active').map((m) => m.id as number));
    const found = new Map<string, NonNullable<Awaited<ReturnType<RunRepository['findRun']>>>>();
    const facts = new Map<string, RunFacts>();
    for (const record of records) {
      const run = record.runKey === null ? null : await this.runs.findRun(record.runKey);
      if (!run) continue;
      found.set(run.key, run);
      facts.set(run.key, { state: deriveState(run).state, currentStep: run.currentStep });
    }
    const tasks = backlogTasks(records, active, facts);
    const visits = await this.visits.latestVisits([...found.values()].map((run) => run.id));
    for (const record of records.filter((task) => !settled(task))) {
      const run = found.get(record.runKey ?? '');
      if (!run) continue;
      const { state, reason } = deriveState(run);
      if (needsPerson(state, reason)) {
        const visit = visits.get(run.id)?.id;
        await this.backlogs.recordEvent(backlogId, `needs-person:${run.key}:${visit ?? 'none'}`, 'run-needs-person', {
          slug: record.slug,
          runKey: run.key,
          state,
          reason: reason?.message ?? '',
          holds: heldBack(record.slug, tasks).join(', '),
        });
      } else if (state === 'done' && !(await this.documents.latestBody(run.key, 'merge_request'))) {
        await this.backlogs.recordEvent(backlogId, `no-request:${run.key}`, 'run-done-without-request', {
          slug: record.slug,
          runKey: run.key,
        });
      }
    }
  }

  /**
   * A red main is told once per head; a green one only as the next green after a red. A main that is pending or could not be read says nothing.
   * Only the repositories of unsettled tasks of a backlog that is not paused are read, so a backlog with nothing to do makes no host call.
   */
  private async observeMains(backlog: Backlog, records: BacklogTaskRecord[], mains: Map<string, MainReading>) {
    const id = backlog.id as number;
    const touched = new Set(records.filter((task) => !settled(task)).flatMap((task) => task.repositories));
    const repositories = backlog.paused ? [] : backlog.repositories.filter((repository) => touched.has(repository));
    await readMains(this.host, repositories, backlog.owner, mains);
    for (const repository of repositories) {
      const reading = mains.get(repository);
      if (reading?.state === 'red') {
        const head = reading.head ?? 'unknown';
        await this.backlogs.recordEvent(id, `main-red:${repository}:${head}`, 'main-red', { repository, head });
      } else if (reading?.state === 'green' && reading.head) {
        if ((await this.backlogs.latestMainEvent(id, repository)) !== 'main-red') continue;
        const head = reading.head;
        await this.backlogs.recordEvent(id, `main-green:${repository}:${head}`, 'main-green', { repository, head });
      }
    }
  }

  private async observeProgress(backlogId: number, records: BacklogTaskRecord[]): Promise<void> {
    const [requirements, milestones] = [
      await this.backlogs.requirements(backlogId),
      await this.backlogs.milestones(backlogId),
    ];
    const progress = backlogProgress(requirements, milestones, records);
    if (progress.requirements.length === 0 && progress.milestones.length === 0) return;
    const numbers = new Map(milestones.map((milestone) => [milestone.id, milestone.number]));
    await this.backlogs.transaction(async (writers) => {
      for (const requirement of requirements.filter((found) => progress.requirements.includes(found.ref))) {
        await writers.saveRequirement({ ...requirement, status: 'closed' });
        await writers.recordEvent(backlogId, `requirement-ready:${requirement.ref}`, 'requirement-ready', {
          ref: requirement.ref,
          milestone: String(numbers.get(requirement.milestoneId)),
        });
      }
      for (const number of progress.milestones) {
        await writers.recordEvent(backlogId, `milestone-ready:${number}`, 'milestone-ready', {
          milestone: String(number),
        });
      }
    });
  }
}
