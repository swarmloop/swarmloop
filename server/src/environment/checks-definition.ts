import { SwarmloopError } from '../core/swarmloop-error';
import type { SandboxMount } from '../core/sandbox-mount';
import { captureTree } from '../git/worktree-tree';
import { readEnvironmentConfig, type EnvironmentConfig } from './environment-config';
import type { EnvironmentRecord } from './environment-types';

/** What the image is resolved from: a config and the git revision its Dockerfile and context are read at. */
export interface ImageSource {
  config: EnvironmentConfig;
  ref?: string;
}

/** The environment definition of the changed files cannot be read, or the project refuses it. */
export class HeadEnvironmentUnreadable extends SwarmloopError {
  constructor(reason: string) {
    super(`the environment definition in the changed files cannot be used: ${reason}`);
    this.name = 'HeadEnvironmentUnreadable';
  }
}

/**
 * The image the checks run in. The head is the worktree's content tree, uncommitted edits included. Only the image, the
 * Dockerfile and its context come from the head; commands, setup, hosts, network and caches stay the run's own, so the
 * head can never widen what the project is allowed to run or reach. A head that names no environment keeps the base's.
 */
export async function checksDefinition(mount: SandboxMount, record: EnvironmentRecord): Promise<ImageSource> {
  const captured = await captureTree(mount.hostPath);
  if (!captured) {
    return { config: record.config, ref: record.ref };
  }
  let head: EnvironmentConfig | null;
  try {
    head = await readEnvironmentConfig(mount.hostPath, captured.tree);
  } catch (error) {
    throw new HeadEnvironmentUnreadable(error instanceof Error ? error.message : String(error));
  }
  if (!head) {
    return { config: record.config, ref: record.ref };
  }
  return {
    config: { ...record.config, image: head.image, dockerfile: head.dockerfile, context: head.context },
    ref: captured.tree,
  };
}
