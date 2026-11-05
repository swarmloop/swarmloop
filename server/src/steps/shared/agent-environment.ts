import { LOCAL_RUN_RULE } from './skill-prompt';
import { environmentNote, withEnvironment } from '../../environment/environment-note';
import type { ProjectEnvironments } from '../../environment/project-environments';
import type { RunEntity } from '../../history/entities';
import { packageRegistries } from '../../sandbox/sandbox-launch';
import type { SandboxMount } from '../../core/sandbox-mount';
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
  input: { run: RunEntity; key: string; step: string; mounts: SandboxMount[] },
  prompt: string,
): Promise<AgentWorkplace> {
  const environment = await environments.prepare(input);
  const executionRules = environment ? environmentNote(environment.record) : LOCAL_RUN_RULE;
  return {
    prompt: withEnvironment(prompt, executionRules),
    executionRules,
    ...(environment ? { project: environment.launch } : {}),
    allowHosts: environment?.record.config.network === 'setup' ? [] : packageRegistries(),
  };
}
