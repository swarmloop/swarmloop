import { existsSync } from 'fs';
import { join, sep } from 'path';
import type { AppConfig } from '../../config/env';
import { isProjectName, resolveCheckoutPath } from '../../config/checkout-path';
import { fallbackFolder } from '../../config/repository-pick';
import type { RemoteRepository } from '../../contract/api';
import { SwarmloopError } from '../../core/swarmloop-error';
import { git } from '../../git/git';
import { root } from '../../history/run-paths';
import type { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { remoteProject } from '../../integrations/code-host/remote-project';

/** Where a repository lives under the checkouts root: its folder, and whether that folder already is a clone of it. */
export type Placement = { folder: string; cloned: boolean } | { blocked: string };

/** Decides the folder of a remote repository: its bare name, or `<name>-<owner>` when another remote holds the bare name. */
export class CheckoutPlacement {
  constructor(
    private readonly config: AppConfig,
    private readonly hosts: CodeHostRegistry,
  ) {}

  /** The folder of a project, which is always inside the checkouts root. */
  folder(name: string): string {
    const base = resolveCheckoutPath(root(this.config), this.config.env.CHECKOUTS_ROOT, '', '');
    const path = resolveCheckoutPath(root(this.config), this.config.env.CHECKOUTS_ROOT, name, '');
    if (!path.startsWith(`${base}${sep}`)) {
      throw new SwarmloopError(`${name} is not inside the checkouts root`);
    }
    return path;
  }

  /** The folder that holds the repository's clone, else the first folder it can be cloned into, else why it cannot. */
  async place(repository: RemoteRepository): Promise<Placement> {
    const candidates = [repository.name, fallbackFolder(repository.owner, repository.name)].filter(isProjectName);
    let free: string | undefined;
    for (const candidate of candidates) {
      const path = this.folder(candidate);
      if (!existsSync(path)) {
        free ??= candidate;
      } else if (await this.holds(path, repository)) {
        return { folder: candidate, cloned: true };
      }
    }
    if (free !== undefined) {
      return { folder: free, cloned: false };
    }
    return {
      blocked: `${repository.owner}/${repository.name} cannot be cloned: the folders ${candidates.join(' and ')} hold other remotes`,
    };
  }

  /** Whether the folder is a clone of the repository: the same host and the same owner and name, whatever the case. */
  private async holds(path: string, repository: RemoteRepository): Promise<boolean> {
    if (!existsSync(join(path, '.git'))) {
      return false;
    }
    const origin = await git(['-C', path, 'remote', 'get-url', 'origin'], undefined, { answers: [2] }).catch(() => '');
    if (!origin) {
      return false;
    }
    try {
      return (
        this.hosts.forOrigin(origin) === repository.host &&
        remoteProject(origin).project.toLowerCase() === `${repository.owner}/${repository.name}`.toLowerCase()
      );
    } catch {
      return false;
    }
  }
}
