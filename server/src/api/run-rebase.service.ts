import { Injectable } from '@nestjs/common';
import { RunRef } from '../contract/api';
import { PipelineService } from '../pipeline/pipeline.service';
import { RunRebase } from '../pipeline/run-rebase';
import { RunCommandsService } from './run-commands.service';

@Injectable()
export class RunRebaseService {
  constructor(
    private readonly action: RunRebase,
    private readonly pipeline: PipelineService,
    private readonly commands: RunCommandsService,
  ) {}

  async rebase(key: string): Promise<RunRef> {
    const next = await this.action.rebase(key);
    if (next === 'resume') return this.commands.resume(key);
    return this.commands.accepted(key, await this.pipeline.startDetached(key));
  }
}
