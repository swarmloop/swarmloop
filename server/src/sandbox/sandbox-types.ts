import type { RuntimeName } from '../integrations/agent-runtime/agent-runtime.registry';
import type { SandboxMount } from '../core/sandbox-mount';
import type { RunImages } from './image-resolver';

export interface EnvMask {
  hostFile: string;
  containerFile: string;
}

export interface SandboxLaunch {
  runtime: RuntimeName;
  runKey: string;
  step: string;
  /** The attempt that starts the container. Empty for a container that no attempt owns, such as the shell. */
  attemptId: string;
  mounts: SandboxMount[];
  envMasks: EnvMask[];
  allowHosts: string[];
  command: string[];
  userId: number;
  maskFile: string;
  /** Only the runtime model key. Other tokens stay out of the container. */
  env?: { name: string; value: string }[];
  /** Durable home for the vendor session. Replaces the /home/sandbox tmpfs. */
  statePath?: string;
  stateDaemonPath?: string;
  /** Run in the project's own image, with the agent CLI mounted read-only from a volume. */
  project?: ProjectLaunch;
  /** The address on the internal sandbox network. Its policy on the egress proxy decides what it reaches. */
  egress?: { ip: string };
  /** The images the run started with. Without them the resolver names the current ones. */
  images?: RunImages;
  /** Attach the caller's stdin. */
  stdin?: boolean;
  /** Allocate a terminal. Only the interactive vendor screen needs one. */
  tty?: boolean;
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
