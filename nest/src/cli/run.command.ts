import { Command, CommandRunner, Option } from 'nest-commander';
import { HistoryService } from '../history/history.service';
import { PipelineService } from '../pipeline/pipeline.service';
import { assertKey, StepOptions } from '../pipeline/pipeline-result';

@Command({
  name: 'run',
  arguments: '<key>',
  description: 'Continue a run from its saved step',
})
export class RunCommand extends CommandRunner {
  constructor(
    private readonly pipeline: PipelineService,
    private readonly history: HistoryService,
  ) {
    super();
  }

  async run(passed: string[], options: StepOptions = {}): Promise<void> {
    const key = passed[0] ?? '';
    if (options.phases?.length) {
      try {
        assertKey(key);
        await this.history.noteFlow(key, options.phases, null);
      } catch (error) {
        await report({ exitCode: 1, message: error instanceof Error ? error.message : 'phases are invalid' });
        return;
      }
    }
    await report(await this.pipeline.runThrough(key, options));
  }

  @Option({ flags: '--prompt <text>', description: 'Required human prompt. A Jira key in it is fetched.' })
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

  @Option({
    flags: '--phase <name>',
    name: 'phases',
    description: 'Phase to include. Repeat the flag. Omit to run every phase. requirements is always included.',
  })
  phases(value: string, previous: string[] = []): string[] {
    return [...previous, value];
  }
}

export async function report(result: { exitCode: number; message: string }): Promise<void> {
  const stream = result.exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`${result.message}\n`);
  process.exitCode = result.exitCode;
}
