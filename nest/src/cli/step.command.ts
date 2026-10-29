import { Command, CommandRunner, Option } from 'nest-commander';
import { PipelineService } from '../pipeline/pipeline.service';
import { StepOptions } from '../pipeline/pipeline-result';
import { report } from './run.command';

@Command({
  name: 'step',
  arguments: '<name> <key>',
  description: 'Run one step when its input exists',
})
export class StepCommand extends CommandRunner {
  constructor(private readonly pipeline: PipelineService) {
    super();
  }

  async run(passed: string[], options: StepOptions = {}): Promise<void> {
    await report(await this.pipeline.step(passed[0] ?? '', passed[1] ?? '', options));
  }

  @Option({ flags: '--prompt <text>', description: 'Human prompt. Required for requirements.' })
  prompt(value: string): string {
    return value;
  }

  @Option({ flags: '--prompt-file <file>', description: 'File whose body is the requirements prompt.' })
  promptFile(value: string): string {
    return value;
  }

  @Option({ flags: '--path <dir>', description: 'Local checkout for code-review.' })
  path(value: string): string {
    return value;
  }
}
