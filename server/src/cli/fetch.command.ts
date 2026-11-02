import { Command, CommandRunner } from 'nest-commander';
import { PipelineService } from '../pipeline/pipeline.service';
import { report } from './run.command';

@Command({
  name: 'fetch',
  arguments: '<key>',
  description: 'Pull one Jira issue into requirements without a human prompt',
})
export class FetchCommand extends CommandRunner {
  constructor(private readonly pipeline: PipelineService) {
    super();
  }

  async run(passed: string[]): Promise<void> {
    await report(await this.pipeline.fetch(passed[0] ?? ''));
  }
}
