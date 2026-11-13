import type { HeavyWork } from '../core/heavy-work';
import type { SandboxLaunch } from './sandbox-types';

/** What a launch is to the machine budget: an agent container, or the check or setup that its shell runs. */
export function heavyWorkOf(
  launch: Pick<SandboxLaunch, 'runtime' | 'runKey' | 'step' | 'project' | 'work' | 'alone'>,
): HeavyWork {
  const alone = launch.alone;
  if (launch.project?.shell === undefined) {
    return {
      kind: 'agent',
      runKey: launch.runKey,
      name: launch.runtime,
      label: `${launch.runtime} agent of ${launch.runKey}`,
      alone,
    };
  }
  const work = launch.work ?? {
    kind: 'setup' as const,
    name: launch.step,
    label: `setup of ${launch.step} for ${launch.runKey}`,
  };
  return { ...work, runKey: launch.runKey, alone };
}
