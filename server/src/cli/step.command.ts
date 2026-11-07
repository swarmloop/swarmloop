import { Command, CommandRunner, Option } from 'nest-commander';
import { CommandService } from '../pipeline/command.service';
import { PipelineService } from '../pipeline/pipeline.service';
import { isStep, StepOptions } from '../core/pipeline-result';
import { report } from './run.command';

@Command({
  name: 'step',
  arguments: '<name> <key>',
  description: 'Run one step when its input exists',
})
export class StepCommand extends CommandRunner {
  constructor(
    private readonly pipeline: PipelineService,
    private readonly commands: CommandService,
  ) {
    super();
  }

  async run(passed: string[], options: StepOptions = {}): Promise<void> {
    const name = passed[0] ?? '';
    const key = passed[1] ?? '';
    if (!isStep(name)) {
      await report({ exitCode: 1, message: `${name} is unknown` });
      return;
    }
    await report(
      await this.commands.inProcess('step', key, { step: name, ...options }, () =>
        this.pipeline.step(name, key, options),
      ),
    );
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
