import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { RunRepository } from '../history/run.repository';
import { DocumentRepository } from '../history/document.repository';
import { CheckoutRepository } from '../history/checkout.repository';
import { PipelineService } from '../pipeline/pipeline.service';
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
    if (questions.length > 0) {
      const text = questions.map((answer) => `question: ${answer.id}\nanswer: ${answer.body?.trim()}`).join('\n\n');
      await this.documents.putDocument(run, 'answers', `${text}\n`);
    }
    for (const answer of incoming.filter((item) => item.kind === 'paste' && item.id && item.body?.trim())) {
      await this.checkouts.savePaste(key, answer.id ?? '', answer.body?.trim() ?? '');
    }
    this.commands.demandStart(await this.pipeline.startDetached(key));
    return this.queries.flow(key);
  }
}
