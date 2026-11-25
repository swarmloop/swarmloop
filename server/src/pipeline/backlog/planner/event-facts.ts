import { Injectable } from '@nestjs/common';
import { AttachmentStore } from '../../../history/attachment-store';
import { BacklogRepository } from '../../../history/backlog.repository';
import type { BacklogEventRecord, Facts } from '../../../history/backlog-writers';
import { DocumentRepository } from '../../../history/document.repository';
import { ARTIFACTS } from '../../../steps/contract/artifacts';
import { MergeMarks } from '../../../steps/shared/merge-marks';
import { readStoredQuestions } from '../../../steps/shared/question-parts';
import { RepositoryHost } from '../../../steps/shared/repository-host';
import { RunFacts, type LabelledText } from './run-facts';

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

/** The folder the turn's agent reads the whole texts in, read only. */
const TURN_FILES = '/work/brief/attachments';

/** Gives each event of a turn the facts the planner needs to act on it, in plain words. It reads, and writes only the whole texts into the turn's folder. */
@Injectable()
export class EventFacts {
  private readonly marks: MergeMarks;

  constructor(
    private readonly backlogs: BacklogRepository,
    private readonly documents: DocumentRepository,
    private readonly host: RepositoryHost,
    private readonly runFacts: RunFacts,
    private readonly files: AttachmentStore,
  ) {
    this.marks = new MergeMarks(documents);
  }

  /** The event's own facts and, for the kinds that have them, the facts read from the run's documents or the code host. */
  async of(owner: string, event: BacklogEventRecord, turnKey: string): Promise<Facts> {
    try {
      if (event.kind === 'run-needs-person') {
        const run = event.facts.endRun ?? event.facts.runKey;
        const asked = await this.question(event.facts.runKey);
        return { ...event.facts, ...asked, ...(await this.run(turnKey, run, event.facts.runKey)) };
      }
      if (event.kind === 'run-asks-planner') {
        const asked = await this.question(event.facts.runKey, event.facts.questionId);
        return { ...event.facts, ...asked, ...(await this.run(turnKey, event.facts.runKey, event.facts.runKey)) };
      }
      if (event.kind === 'command-refused') {
        return { ...event.facts, ...(await this.run(turnKey, event.facts.run, event.facts.run)) };
      }
      if (event.kind === 'task-merged') return { ...event.facts, ...(await this.merged(event)) };
      if (event.kind === 'main-red')
        return { ...event.facts, ...(await this.failedJob(owner, event.facts.repository)) };
      return event.facts;
    } catch (error) {
      return { ...event.facts, note: `its facts could not be read: ${reasonOf(error)}` };
    }
  }

  /** What is decided and each side of every question the run waits on, or of the one question named, in the shape the run page shows. */
  private async question(runKey: string | undefined, questionId?: string): Promise<Facts> {
    if (!runKey) return {};
    const parts = readStoredQuestions((await this.documents.latestBody(runKey, 'question_parts')) ?? '');
    const stored = questionId === undefined ? parts : parts.filter((item) => item.question === questionId);
    if (questionId !== undefined && stored.length === 0) return {};
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

  /** The run's failed step, its error, its failed check commands and its failed CI jobs, each cut by `tail` with its whole text in the turn's folder. `part` names the run when it is not the event's own. */
  private async run(turnKey: string, runKey: string | undefined, own: string | undefined): Promise<Facts> {
    const texts = runKey ? await this.runFacts.of(runKey) : null;
    if (!runKey || !texts) return {};
    const facts: Facts = { step: texts.step };
    if (runKey !== own) facts.part = runKey;
    if (texts.error) facts.error = await this.cut(turnKey, `${runKey}-error.txt`, texts.error);
    for (const [kind, found] of [
      ['checks', texts.checks],
      ['ci', texts.ci],
    ] as const) {
      const cut = await Promise.all(
        found.map((item, index) => this.cutLabelled(turnKey, runKey, kind, item, index, found.length)),
      );
      if (cut.length > 0) facts[kind] = cut.join('\n\n');
    }
    return facts;
  }

  private async cutLabelled(
    turnKey: string,
    runKey: string,
    kind: string,
    item: LabelledText,
    index: number,
    count: number,
  ) {
    const file = `${runKey}-${kind}${count > 1 ? `-${index + 1}` : ''}.txt`;
    return `${item.label}\n${await this.cut(turnKey, file, item.text)}`;
  }

  /** The text cut to its last lines, and the whole text written into the turn's folder under `file`. */
  private async cut(turnKey: string, file: string, text: string): Promise<string> {
    await this.files.write(turnKey, file, text);
    return tail(text, LOG_LINES, `in ${TURN_FILES}/${file}`);
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
    const statuses = body ? ARTIFACTS.reviewRequirementsResult.parse(body).requirements : undefined;
    if (statuses && statuses.length > 0) {
      facts.requirements = statuses.map((mark) => `${mark.id} is ${mark.status}: ${mark.note}`).join('\n');
    }
    const marks = await this.marks.taskMarks(runKey, task);
    if (marks.length > 0) facts.marks = marks.join('\n');
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
