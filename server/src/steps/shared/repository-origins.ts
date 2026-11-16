import { existsSync } from 'fs';
import { join } from 'path';
import { Injectable } from '@nestjs/common';
import { resolveCheckoutPath } from '../../config/checkout-path';
import { AppConfig } from '../../config/env';
import { SwarmloopError } from '../../core/swarmloop-error';
import { originUrl } from '../../git/git';
import { root } from '../../history/run-paths';
import { remoteProject } from '../../integrations/code-host/remote-project';

interface RepositoryOrigin {
  origin: string;
  project: string;
}

/** Where a repository of the checkouts root lives on its code host. */
@Injectable()
export class RepositoryOrigins {
  constructor(private readonly config: AppConfig) {}

  async of(repo: string): Promise<RepositoryOrigin> {
    const path = resolveCheckoutPath(root(this.config), this.config.env.CHECKOUTS_ROOT, repo, '');
    if (!existsSync(join(path, '.git'))) {
      throw new SwarmloopError(`${repo} is not a checkout`);
    }
    const origin = await originUrl(path, repo, 'origin failed');
    if (origin === null) {
      throw new SwarmloopError(`${repo} has no origin`);
    }
    return { origin, project: remoteProject(origin).project };
  }
}
