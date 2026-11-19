import { Injectable } from '@nestjs/common';
import { BacklogRepository } from '../../../history/backlog.repository';
import type { BacklogEventRecord, Facts } from '../../../history/backlog-writers';
import { DocumentRepository } from '../../../history/document.repository';
import { ARTIFACTS } from '../../../steps/contract/artifacts';
import { readStoredQuestions } from '../../../steps/shared/question-parts';
import { RepositoryHost } from '../../../steps/shared/repository-host';

/** The lines of a failing job's log that the planner reads, the last ones. */
const LOG_LINES = 60;
/** The lines of a merged run's commit note that the planner reads. */
const NOTE_LINES = 40;

/** The text, or its last `keep` lines after a note that says how many lines are left out and where the whole text is. */
function tail(text: string, keep: number, whole: string): string {
  const lines = text.trimEnd().split('\n');
  if (lines.length <= keep) return lines.join('\n');
  return [`${lines.length - keep} earlier lines are left out; the whole text is ${whole}.`, ...lines.slice(-keep)].join(
    '\n',
  );
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : 'the read failed';
}

/** Gives each event of a turn the facts the planner needs to act on it, in plain words. Only reads. */
@Injectable()
export class EventFacts {
  constructor(
    private readonly backlogs: BacklogRepository,
    private readonly documents: DocumentRepository,
    private readonly host: RepositoryHost,
  ) {}

  /** The event's own facts and, for the kinds that have them, the facts read from the run's documents or the code host. */
  async of(owner: string, event: BacklogEventRecord): Promise<Facts> {
    try {
      if (event.kind === 'run-needs-person') return { ...event.facts, ...(await this.question(event.facts.runKey)) };
      if (event.kind === 'task-merged') return { ...event.facts, ...(await this.merged(event)) };
      if (event.kind === 'main-red')
        return { ...event.facts, ...(await this.failedJob(owner, event.facts.repository)) };
      return event.facts;
    } catch (error) {
      return { ...event.facts, note: `its facts could not be read: ${reasonOf(error)}` };
    }
  }

  /** What is decided and each side of every question the run waits on, in the shape the run page shows. */
  private async question(runKey: string | undefined): Promise<Facts> {
    if (!runKey) return {};
    const stored = readStoredQuestions((await this.documents.latestBody(runKey, 'question_parts')) ?? '');
    if (stored.length > 0) {
      return {
        question: stored.map(({ parts }) => parts.decide).join('\n'),
        sides: stored
          .flatMap(({ parts }) => parts.sides.map((side) => `${side.who}: ${side.text.replaceAll('\n', ' ')}`))
          .join('\n'),
      };
    }
    const asked = (await this.documents.latestBody(runKey, 'questions'))?.trim();
    return asked ? { question: asked } : { note: 'the run has no stored question' };
  }

  private async merged(event: BacklogEventRecord): Promise<Facts> {
    const slug = event.facts.slug;
    const task = (await this.backlogs.tasks(event.backlogId)).find((record) => record.slug === slug);
    const runKey = task?.runKey;
    if (!runKey) return { note: 'the task has no run' };
    const facts: Facts = {};
    const report = (await this.documents.latestBody(runKey, ARTIFACTS.reviewReport.kind))?.trim();
    if (report) facts.report = report;
    const body = await this.documents.latestBody(runKey, ARTIFACTS.reviewRequirementsResult.kind);
    const marks = body ? ARTIFACTS.reviewRequirementsResult.parse(body).requirements : undefined;
    if (marks && marks.length > 0) {
      facts.requirements = marks.map((mark) => `${mark.id} is ${mark.status}: ${mark.note}`).join('\n');
    }
    const commit = (await this.documents.latestBody(runKey, ARTIFACTS.commit.kind))?.trim();
    if (commit) facts.diff = tail(commit, NOTE_LINES, `in the commit note of run ${runKey}`);
    return Object.keys(facts).length > 0 ? facts : { note: 'the run stored no report' };
  }

  private async failedJob(owner: string, repository: string | undefined): Promise<Facts> {
    if (!repository) return {};
    const job = await this.host.failedMainJob(repository, owner);
    if (!job) return { note: 'no failed job of a workflow is listed for this main' };
    const whole = job.url ? `at ${job.url}` : `in the job log on the code host`;
    return { job: job.name, log: tail(job.trace, LOG_LINES, whole) };
  }
}
