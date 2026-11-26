import type { LiveHub } from '../live/live.hub';
import type { AgentHold } from '../sandbox/container-gate';
import type { AgentRunInput } from './agent-run-input';
import { recordLaunch } from './agent-launches';

/**
 * What a launch takes from the world around its process: the step's live view, an agent place, its session file and
 * the count of the step's launches. A fork is no visit, so it takes none of them.
 */
export class LaunchScope {
  constructor(
    private readonly input: Pick<AgentRunInput, 'fork' | 'sessionFile' | 'outputFile' | 'runKey'>,
    private readonly hub: LiveHub | undefined,
  ) {}

  /** The live view the launch shows itself in, if any. */
  get live(): LiveHub | undefined {
    return this.input.fork ? undefined : this.hub;
  }

  /** The file the launch's chat is saved in; none for a fork. */
  get sessionFile(): string | null {
    return this.input.fork ? null : this.input.sessionFile;
  }

  /** What the sandbox holds the start for: the pause always, an agent place only for a launch that is a visit. */
  held(onPaused: () => void, agent: AgentHold): { onPaused: () => void; agent?: AgentHold } {
    return this.input.fork ? { onPaused } : { onPaused, agent };
  }

  /** Counts the launch among the step's launches. */
  async countLaunch(step: string): Promise<void> {
    if (!this.input.fork) await recordLaunch(this.input.outputFile, this.input.runKey, step);
  }
}
