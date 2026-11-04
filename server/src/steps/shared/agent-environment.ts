import { environmentNote, withEnvironment } from '../../environment/environment-note';
import type { ProjectEnvironments } from '../../environment/project-environments';
import type { RunEntity } from '../../history/entities';
import { packageRegistries } from '../../sandbox/sandbox-launch';
import type { ProjectLaunch, SandboxMount } from '../../sandbox/sandbox-launch';

export interface AgentWorkplace {
  prompt: string;
  project?: ProjectLaunch;
  /** Hosts besides the model API. A project that keeps the registries to its setup gives the agent none. */
  allowHosts: string[];
}

/**
 * Where an implementation agent works. With a project environment it runs in the project image and checks its own
 * work. Without one it stays in the agent image with the prompt as it is, and CI is the first check.
 */
export async function agentWorkplace(
  environments: Pick<ProjectEnvironments, 'prepare'>,
  input: { run: RunEntity; key: string; step: string; mounts: SandboxMount[] },
  prompt: string,
): Promise<AgentWorkplace> {
  const environment = await environments.prepare(input);
  if (!environment) {
    return { prompt, allowHosts: packageRegistries() };
  }
  return {
    prompt: withEnvironment(prompt, environmentNote(environment.record)),
    project: environment.launch,
    allowHosts: environment.record.config.network === 'setup' ? [] : packageRegistries(),
  };
}
