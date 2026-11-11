import { Injectable } from '@nestjs/common';
import { agentFor } from '../../config/agents';
import { StepName } from '../../contract/steps';
import { EnvironmentService } from '../../environment/environment.service';
import { RequiredCheckFailed, RequiredCheckRepeated } from '../../environment/project-environments';
import { checkedRepoNames, mountsForStep } from '../../git/repo-names';
import { EventRepository } from '../../history/event.repository';
import { root } from '../../history/run-paths';
import type { SampleDraft } from '../../history/visit';
import { BaseStep, StepContext } from '../base-step';
import { ARTIFACTS } from '../contract/artifacts';
import type { InputSpec, StepInput, StepResult } from '../contract/step-contract';
import { checkRepeatedBlock, checksLine, implementFacts } from '../implement/implement-record';
import { issueOf } from '../shared/handoff';
import { StepKernel } from '../step-kernel';

const INPUTS = {
  repos: { artifact: ARTIFACTS.repos, need: 'start' },
} as const satisfies InputSpec;

/** The server checks of the project, run after the implementation. A failure returns to implement, as a review does. */
@Injectable()
export class ChecksStep extends BaseStep<typeof INPUTS> {
  readonly name: StepName = 'checks';
  readonly inputs = INPUTS;
  readonly outputs = [ARTIFACTS.issues];

  constructor(
    kernel: StepKernel,
    private readonly environments: EnvironmentService,
    private readonly events: EventRepository,
  ) {
    super(kernel);
  }

  protected async work(input: StepInput<typeof INPUTS>, ctx: StepContext): Promise<StepResult> {
    const { opened } = ctx;
    const { key } = opened.run;
    const mounts = mountsForStep(root(this.config), key, checkedRepoNames(input.repos ?? []), opened.run.targetPath);
    const samples: SampleDraft[] = [];
    const place = {
      run: opened.run,
      key,
      step: this.name,
      mounts,
      runtime: agentFor(this.config.env, null, 'implement').runtime,
      samples,
    };
    try {
      const checks = checksLine(await ctx.activity('Server checks', () => this.environments.check(place), checksLine));
      return {
        route: { to: 'next' },
        summary: `${opened.startedAt} checks done\n${checks}`,
        outputs: [],
        facts: implementFacts(checks),
        visit: { samples },
      };
    } catch (error) {
      if (error instanceof RequiredCheckRepeated) {
        return { ...checkRepeatedBlock(opened.startedAt, this.name, error), visit: { samples } };
      }
      if (error instanceof RequiredCheckFailed) {
        return this.returned(opened, error.message, samples);
      }
      throw error;
    }
  }

  /** The failed commands go back to implement as one issue; the `return` notes are stored with the failures. */
  private async returned(opened: StepContext['opened'], body: string, samples: SampleDraft[]): Promise<StepResult> {
    const { run } = opened;
    run.attemptsChecks += 1;
    await this.events.recordLoop(run, 'checks', run.attemptsChecks, 'required checks failed');
    const issues = [issueOf('checks', 'required checks failed', body)];
    return {
      route: { to: 'return', step: 'implement', issues },
      summary: `${opened.startedAt} checks waiting\n${body}`,
      outputs: [{ artifact: ARTIFACTS.issues, value: issues }],
      visit: { samples },
    };
  }
}
