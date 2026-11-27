import type { LiveHub } from '../live/live.hub';
import type { AgentHold } from '../sandbox/container-gate';
import type { AgentRunInput } from './agent-run-input';
import { recordLaunch } from './agent-launches';

/**
 * What a launch takes from the world around its process: the step's live view, an agent place, its session file and
 * the count of the step's launches.
 */
export class LaunchScope {
  constructor(
    private readonly input: Pick<AgentRunInput, 'sessionFile' | 'outputFile' | 'runKey'>,
    private readonly hub: LiveHub | undefined,
  ) {}

  /** The live view the launch shows itself in, if any. */
  get live(): LiveHub | undefined {
    return this.hub;
  }

  /** The file the launch's chat is saved in. */
  get sessionFile(): string | null {
    return this.input.sessionFile;
  }

  /** What the sandbox holds the start for: the pause and an agent place. */
  held(onPaused: () => void, agent: AgentHold): { onPaused: () => void; agent: AgentHold } {
    return { onPaused, agent };
  }

  /** Counts the launch among the step's launches. */
  async countLaunch(step: string): Promise<void> {
    await recordLaunch(this.input.outputFile, this.input.runKey, step);
  }
}
