import { existsSync, readFileSync } from 'node:fs';
import { Injectable } from '@nestjs/common';
import { AppConfig } from '../../../config/env';
import { redact } from '../../../config/redact';
import { readCheckOutput } from '../../../core/check-output';
import { runLogPath } from '../../../core/run-logs';
import { CheckCommandRepository } from '../../../history/check-command.repository';
import { DocumentRepository } from '../../../history/document.repository';
import { RunRepository } from '../../../history/run.repository';
import { root } from '../../../history/run-paths';
import { VisitRepository } from '../../../history/visit.repository';
import { ARTIFACTS } from '../../../steps/contract/artifacts';
import { failedJobs } from '../../../steps/pipeline/failed-jobs';

/** One whole text of a run with the words that say what it is. */
export interface LabelledText {
  label: string;
  text: string;
}

/** What a person reads on a run's page of why it stopped. Each text is whole and redacted; a part with nothing to give is not there. */
interface RunTexts {
  step: string;
  error?: string;
  checks: LabelledText[];
  ci: LabelledText[];
}

const ERROR_KIND = 'error';

/** Reads the failed step, its error, the failed check commands and the failed CI jobs of one run. Only reads. */
@Injectable()
export class RunFacts {
  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly commands: CheckCommandRepository,
    private readonly visits: VisitRepository,
    private readonly config: AppConfig,
  ) {}

  /** The whole texts of the run, or null when no run has this key. */
  async of(runKey: string): Promise<RunTexts | null> {
    const run = await this.runs.findRun(runKey);
    if (!run) return null;
    const texts: RunTexts = { step: run.currentStep, checks: await this.checks(run), ci: await this.ci(run) };
    const error = await this.error(run);
    if (error) texts.error = error;
    return texts;
  }

  /** The newest error document, when the latest visit wrote it: the text the failed step's window shows. */
  private async error(run: { id: number }): Promise<string | null> {
    const [document] = await this.documents.latestDocuments([run.id], [ERROR_KIND]);
    const latest = (await this.visits.latestVisits([run.id])).get(run.id);
    return document && latest && document.stepStatId === latest.id ? redact(document.body).trim() || null : null;
  }

  /** Each command of the newest checks visit that failed, with all it wrote. */
  private async checks(run: { id: number; key: string }): Promise<LabelledText[]> {
    const rows = await this.commands.list(run.id);
    const attemptId = rows.at(-1)?.attemptId;
    const found: LabelledText[] = [];
    for (const row of rows.filter((item) => item.attemptId === attemptId)) {
      if (row.status !== 'failed' && !(row.exitCode !== null && row.exitCode !== 0)) continue;
      const output = readCheckOutput(root(this.config), run.key, 'checks', row.attemptId, row.commandIndex);
      if (output?.trim()) found.push({ label: `${row.repo}: ${row.name ?? row.command}`, text: redact(output) });
    }
    return found;
  }

  /** Each failed job of the latest CI report, with its whole trace when the pipeline step saved one, else the report's own block. */
  private async ci(run: { id: number; key: string }): Promise<LabelledText[]> {
    const report = (await this.documents.latestBody(run.key, ARTIFACTS.pipelineLog.kind)) ?? '';
    const blocks = report.includes('result: fail\n') ? failedJobs(report) : [];
    if (blocks.length === 0) return [];
    const attempt = (await this.visits.listStats(run.id)).filter((stat) => stat.step === 'pipeline').at(-1)?.attemptId;
    return blocks.map((block, index) => ({
      label: `${block.project}: ${block.job}`,
      text: redact(this.trace(run.key, attempt, index) ?? block.text),
    }));
  }

  private trace(key: string, attempt: string | null | undefined, index: number): string | null {
    if (!attempt) return null;
    const file = runLogPath(root(this.config), key, `pipeline-${attempt}-job-${index}`);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  }
}
