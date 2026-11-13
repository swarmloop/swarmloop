import type { RuntimeName } from '../integrations/agent-runtime/agent-runtime.registry';
import type { SandboxMount } from '../core/sandbox-mount';

export interface EnvMask {
  hostFile: string;
  containerFile: string;
}

/** The hosts a project manifest added to `allowHosts`, and the hosts of the checkout's remotes. The guard checks them again. */
export interface ManifestHosts {
  hosts: string[];
  origins: string[];
}

export interface SandboxLaunch {
  runtime: RuntimeName;
  runKey: string;
  step: string;
  /** The attempt that starts the container. Empty for a container that no attempt owns, such as the shell. */
  attemptId: string;
  mounts: SandboxMount[];
  /** The folders a `/work` mount may come from: the repositories the server is given and `worktrees/`. */
  workRoots: string[];
  envMasks: EnvMask[];
  allowHosts: string[];
  /** The part of `allowHosts` that comes from the project manifest. */
  manifestHosts?: ManifestHosts;
  command: string[];
  userId: number;
  maskFile: string;
  /** Only the runtime model key. Other tokens stay out of the container. */
  env?: { name: string; value: string }[];
  /** Names the container gets with an empty value, to clear what the image or a profile would set. */
  unsetEnv?: string[];
  /** Durable home for the vendor session. Replaces the /home/sandbox tmpfs. */
  statePath?: string;
  stateDaemonPath?: string;
  /** Run in the project's own image, with the agent CLI mounted read-only from a volume. */
  project?: ProjectLaunch;
  /** The address on the internal sandbox network. Its policy on the egress proxy decides what it reaches. */
  egress?: { ip: string };
  /** Attach the caller's stdin. */
  stdin?: boolean;
  /** Allocate a terminal. Only the interactive vendor screen needs one. */
  tty?: boolean;
  /** What a shell launch is for the machine budget: a check command or a setup. Without it a shell launch is a setup. */
  work?: { kind: 'check' | 'setup'; name: string; label: string };
  /** Hears why the launch waits for machine resources. */
  onWait?: (reason: string) => void;
  /** Starts with nothing else running, such as the retry of a check that ran out of memory. */
  alone?: boolean;
  /** The memory the container may take. Set by the service from the footprint unless the caller gives it. */
  memoryCapBytes?: number;
}

export interface ProjectLaunch {
  image: string;
  /** The volume that holds the agent image's /opt/swarmloop. */
  cliVolume: string;
  /** PATH of the project image. The CLI directory goes in front of it. */
  path: string;
  /** The image has no CA bundle of its own, so OpenSSL tools use the one from the CLI volume. */
  certFile: boolean;
  /** Package-manager caches below /home/sandbox, kept between runs. */
  caches: { daemonPath: string; containerPath: string }[];
  /** A shell command to run instead of the agent CLI, for the setup of the environment. */
  shell?: string;
}
