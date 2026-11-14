import type { ResultDefinition } from '../agent-result/result-definition';
import type { SampleDraft } from '../history/visit';
import type { SandboxMount } from '../core/sandbox-mount';
import type { RuntimeName } from '../integrations/agent-runtime/runtime-name';
import type { ManifestHosts, ProjectLaunch } from '../sandbox/sandbox-launch';
import type { OpenedStep } from './step-run';
import type { StepContext } from './base-step';
import type { LaunchResult } from './shared/result-exchange';

export interface ModelStepContext {
  opened: OpenedStep;
  workspace: string;
  /** Where the samples of other containers of the step go: the visit shows them next to the agent's. */
  samples: SampleDraft[];
  reread: StepContext['reread'];
  write: StepContext['write'];
  activity: StepContext['activity'];
  launch: (input: {
    prompt: string;
    mounts: SandboxMount[];
    allowHosts?: string[];
    manifestHosts?: ManifestHosts;
    label?: string;
    continuePrompt?: string;
    /** The full prompt, for the fresh chat that starts when the CLI no longer has the stored one. */
    freshPrompt?: string;
    resume?: boolean;
    project?: ProjectLaunch;
    /** The full prompt for a new chat on the given runtime, when the launch moves to another agent after a provider limit. */
    briefFor?: (runtime: RuntimeName) => string;
    /** The project launch for the runtime of another agent, when the launch moves to one after a provider limit. */
    projectFor?: (runtime: RuntimeName) => Promise<ProjectLaunch | undefined>;
    /** The result block the answer must end with. The launch returns its validated object as `resultValue`. */
    result?: ResultDefinition;
    /** Checks the validated object. Each message goes back to the agent in the follow-up. */
    check?: (value: unknown) => string[];
  }) => Promise<LaunchResult>;
}
