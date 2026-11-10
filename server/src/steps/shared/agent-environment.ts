import { LOCAL_RUN_RULE } from './skill-prompt';
import { environmentNote, withEnvironment } from '../../environment/environment-note';
import type { EnvironmentInput, ProjectEnvironments } from '../../environment/project-environments';
import type { RuntimeName } from '../../integrations/agent-runtime/runtime-name';
import { packageRegistries } from '../../sandbox/sandbox-launch';
import type { ProjectLaunch } from '../../sandbox/sandbox-launch';

interface AgentWorkplace {
  prompt: string;
  /** Reuse the same execution policy for follow-up launches without preparing the environment again. */
  executionRules: string;
  project?: ProjectLaunch;
  /** Hosts besides the model API. A project that keeps the registries to its setup gives the agent none. */
  allowHosts: string[];
}

/**
 * Where an implementation agent works. With a project environment it runs in the project image and checks its own
 * work. Without one it stays in the agent image with local execution limits, and CI is the first check.
 */
export async function agentWorkplace(
  environments: Pick<ProjectEnvironments, 'prepare'>,
  input: EnvironmentInput,
  prompt: string,
): Promise<AgentWorkplace> {
  const environment = await environments.prepare(input);
  const executionRules = environment ? environmentNote(environment.record, input.step) : LOCAL_RUN_RULE;
  return {
    prompt: withEnvironment(prompt, executionRules),
    executionRules,
    ...(environment ? { project: environment.launch } : {}),
    allowHosts: environment?.record.config.network === 'setup' ? [] : packageRegistries(),
  };
}

/** The project launch for the runtime of another agent, for a launch that moves to one after a provider limit. */
export function projectFor(
  environments: Pick<ProjectEnvironments, 'prepare'>,
  input: EnvironmentInput,
): (runtime: RuntimeName) => Promise<ProjectLaunch | undefined> {
  return async (runtime) => (await environments.prepare({ ...input, runtime }))?.launch;
}
