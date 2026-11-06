import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import { DocumentRepository } from '../history/document.repository';
import { FlowRepository } from '../history/flow.repository';
import { RunRepository } from '../history/run.repository';
import { VisitRepository } from '../history/visit.repository';

/** The services every step is built on. A step takes this one dependency instead of six. */
@Injectable()
export class StepKernel {
  constructor(
    readonly runs: RunRepository,
    readonly documents: DocumentRepository,
    readonly visits: VisitRepository,
    readonly flows: FlowRepository,
    readonly clock: Clock,
    readonly config: AppConfig,
  ) {}
}
