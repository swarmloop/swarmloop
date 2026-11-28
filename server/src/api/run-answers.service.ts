import { BadRequestException, ConflictException, Injectable, Optional } from '@nestjs/common';
import type { RunEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { DocumentRepository } from '../history/document.repository';
import { CheckoutRepository } from '../history/checkout.repository';
import { PipelineService } from '../pipeline/pipeline.service';
import { PlannerTurns } from '../pipeline/planner-turns';
import { AnswersBody, FlowView } from '../contract/api';
import { requireRun, RunQueriesService } from './run-queries.service';
import { Clock } from '../core/clock';
import { renderAnswers } from '../steps/shared/answers';
import { readAnsweredQuestions, readStoredQuestions, type AnsweredQuestion } from '../steps/shared/question-parts';
import { ARTIFACTS } from '../steps/contract/artifacts';
import { RedMainWait } from '../pipeline/backlog/red-main-wait';
import { RunCommandsService } from './run-commands.service';

@Injectable()
export class RunAnswersService {
  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly checkouts: CheckoutRepository,
    private readonly pipeline: PipelineService,
    private readonly queries: RunQueriesService,
    private readonly commands: RunCommandsService,
    private readonly clock: Clock,
    @Optional() private readonly turns?: PlannerTurns,
    @Optional() private readonly redMain?: RedMainWait,
  ) {}

  async answers(key: string, body: AnswersBody, waitsForMain?: string): Promise<FlowView> {
    const run = await requireRun(this.runs, key);
    if (this.runs.held(run)) {
      throw new ConflictException(`${key} is already running`);
    }
    const incoming = body.answers ?? [];
    const view = await this.queries.flow(key);
    for (const item of view.items) {
      const found = incoming.find((answer) => answer.kind === item.kind && answer.id === item.id);
      if (!found?.body?.trim()) {
        throw new BadRequestException('answers are missing');
      }
    }
    const questions = incoming.filter((answer) => answer.kind === 'question' && answer.id && answer.body?.trim());
    await this.saveQuestions(
      run,
      questions.map((answer) => [answer.id ?? '', answer.body?.trim() ?? '']),
    );
    for (const answer of incoming.filter((item) => item.kind === 'paste' && item.id && item.body?.trim())) {
      await this.checkouts.savePaste(key, answer.id ?? '', answer.body?.trim() ?? '');
    }
    return this.start(key, waitsForMain);
  }

  /** One message answers the run: the oldest open paste item, else every open question with the one text. */
  async fromMessage(key: string, message: string, waitsForMain?: string): Promise<FlowView> {
    const run = await requireRun(this.runs, key);
    if (this.runs.held(run)) {
      throw new ConflictException(`${key} is already running`);
    }
    const text = message.trim();
    const { items } = await this.queries.flow(key);
    const paste = items.find((item) => item.kind === 'paste');
    if (!text || items.length === 0) {
      throw new BadRequestException('answers are missing');
    }
    if (paste) {
      await this.checkouts.savePaste(key, paste.id, text);
    } else {
      await this.saveQuestions(
        run,
        items.filter((item) => item.kind === 'question').map((item) => [item.id, text]),
      );
    }
    return this.start(key, waitsForMain);
  }

  /** The `answers` document: one `question`/`answer` pair per answered question, and the record of the answered ones that have parts. */
  private async saveQuestions(run: RunEntity, pairs: string[][]): Promise<void> {
    if (pairs.length === 0) return;
    await this.documents.putDocument(
      run,
      'answers',
      renderAnswers(pairs.map(([question, answer]) => [question, answer])),
    );
    await this.recordAnswered(run, pairs);
  }

  /**
   * Adds one entry of asker, decision, answer and time per answered question that has stored parts, so the question
   * is never asked again. An entry of the same asker and decision is replaced.
   */
  private async recordAnswered(run: RunEntity, pairs: string[][]): Promise<void> {
    const stored = readStoredQuestions((await this.documents.latestBody(run.key, ARTIFACTS.questionParts.kind)) ?? '');
    const given: AnsweredQuestion[] = pairs.flatMap(([question, answer]) => {
      const found = stored.find((item) => item.question === question);
      return found
        ? [{ asker: found.parts.asker ?? '', decide: found.parts.decide, answer, at: this.clock.iso() }]
        : [];
    });
    if (given.length === 0) return;
    const before = readAnsweredQuestions(
      (await this.documents.latestBody(run.key, ARTIFACTS.answeredQuestions.kind)) ?? '',
    );
    const kept = before.filter((item) => !given.some((one) => one.asker === item.asker && one.decide === item.decide));
    await this.documents.putDocument(
      run,
      ARTIFACTS.answeredQuestions.kind,
      ARTIFACTS.answeredQuestions.format([...kept, ...given]),
    );
  }

  /** Offers the answers, then starts the run, or holds it for a green main of `waitsForMain` when the backlog planner gave that. */
  private async start(key: string, waitsForMain?: string): Promise<FlowView> {
    await this.turns?.offerAnswers(key);
    if (waitsForMain !== undefined && this.redMain) {
      await this.redMain.hold(await requireRun(this.runs, key), waitsForMain);
      return this.queries.flow(key);
    }
    this.commands.demandStart(await this.pipeline.startDetached(key));
    return this.queries.flow(key);
  }
}
