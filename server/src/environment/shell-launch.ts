import type { SandboxMount } from '../core/sandbox-mount';
import type { RunEntity } from '../history/entities';
import type { SampleDraft } from '../history/visit';
import type { RuntimeName } from '../integrations/agent-runtime/agent-runtime';
import type { ManifestHosts, ProjectLaunch } from '../sandbox/sandbox-launch';
import { setupHosts } from '../sandbox/sandbox-hosts';
import type { CpuSlice } from '../sandbox/sandbox-types';
import type { SandboxService } from '../sandbox/sandbox.service';

/** What a shell needs of the run: the same fields as an environment input. */
export interface ShellInput {
  run: RunEntity;
  key: string;
  step: string;
  mounts: SandboxMount[];
  runtime: RuntimeName;
  samples?: SampleDraft[];
}

interface ShellLaunchInput {
  input: ShellInput;
  launch: ProjectLaunch;
  command: string;
  mount: SandboxMount;
  phase: 'setup' | 'checks';
  check?: { index: number };
  place?: number;
  cpuSlice?: CpuSlice | null;
  manifest?: ManifestHosts;
  statePath: string;
  userId: number;
}

/** The sandbox launch of one setup or check command. */
function shellLaunch(args: ShellLaunchInput): Parameters<SandboxService['spawn']>[0] {
  const { input, launch, command, mount, phase, check, place, manifest, statePath, userId } = args;
  return {
    runtime: input.runtime,
    runKey: input.key,
    step: check ? `${input.step}-${check.index}` : input.step,
    attemptId: input.run.activeAttempt ?? '',
    mounts: [mount, ...input.mounts.filter((item) => item !== mount)],
    statePath,
    allowHosts: phase === 'setup' ? setupHosts(manifest?.hosts) : [],
    ...(phase === 'setup' && manifest?.hosts.length ? { manifestHosts: manifest } : {}),
    command: [],
    userId,
    project: { ...launch, shell: command },
    resultLost: true,
    ...(place !== undefined ? { checkPlace: place } : {}),
    ...(args.cpuSlice !== undefined ? { cpuSlice: args.cpuSlice } : {}),
  };
}

/** Starts the shell with its admission allocation and closes the caller's output on a failed launch. */
export async function startShell(
  sandbox: Pick<SandboxService, 'spawn'>,
  args: ShellLaunchInput,
  onPaused: () => void,
  onFailure: () => Promise<void>,
): ReturnType<SandboxService['spawn']> {
  try {
    return await sandbox.spawn(shellLaunch(args), {
      onPaused,
      work: args.phase === 'setup' ? 'setup' : 'check',
    });
  } catch (error) {
    await onFailure();
    throw error;
  }
}
