import { Injectable, Optional } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import { DocumentRepository } from '../history/document.repository';
import { LiveHub } from '../live/live.hub';
import { SandboxService } from '../sandbox/sandbox.service';
import { ProjectEnvironments } from './project-environments';

export { ENVIRONMENT, type EnvironmentRecord, type PreparedEnvironment } from './project-environments';

@Injectable()
export class EnvironmentService extends ProjectEnvironments {
  constructor(
    config: AppConfig,
    clock: Clock,
    sandbox: SandboxService,
    documents: DocumentRepository,
    @Optional() live?: LiveHub,
  ) {
    super({ env: () => config.env, clock, sandbox, documents, live });
  }
}
