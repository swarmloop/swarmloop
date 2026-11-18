import { BadRequestException, ConflictException, Injectable, Optional } from '@nestjs/common';
import type { RunEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { DocumentRepository } from '../history/document.repository';
import { CheckoutRepository } from '../history/checkout.repository';
import { PipelineService } from '../pipeline/pipeline.service';
import { PlannerTurns } from '../pipeline/planner-turns';
import { AnswersBody, FlowView } from '../contract/api';
import { requireRun, RunQueriesService } from './run-queries.service';
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
    @Optional() private readonly turns?: PlannerTurns,
  ) {}

  async answers(key: string, body: AnswersBody): Promise<FlowView> {
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
    return this.start(key);
  }

  /** One message answers the run: the oldest open paste item, else every open question with the one text. */
  async fromMessage(key: string, message: string): Promise<FlowView> {
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
    return this.start(key);
  }

  /** The `answers` document: one `question`/`answer` pair per answered question. */
  private async saveQuestions(run: RunEntity, pairs: string[][]): Promise<void> {
    if (pairs.length > 0) {
      const text = pairs.map(([question, answer]) => `question: ${question}\nanswer: ${answer}`).join('\n\n');
      await this.documents.putDocument(run, 'answers', `${text}\n`);
    }
  }

  private async start(key: string): Promise<FlowView> {
    await this.turns?.offerAnswers(key);
    this.commands.demandStart(await this.pipeline.startDetached(key));
    return this.queries.flow(key);
  }
}
