import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { listGitProjects, resolveCheckoutPath } from '../config/checkout-path';
import { git, GIT_LIMITS } from '../git/git';
import { root } from '../history/run-paths';
import { remoteProject } from '../integrations/code-host/remote-project';
import type { ProviderName, RepoRef } from './oauth-provider';

/** The repositories this server works on (`CHECKOUTS_ROOT`, narrowed by `SWARMLOOP_REPOS`), read from their origins. */
@Injectable()
export class CheckoutRepos {
  constructor(private readonly config: AppConfig) {}

  /** A checkout with no readable origin, or on another host than GitHub or GitLab, is left out. */
  async list(): Promise<RepoRef[]> {
    const { env } = this.config;
    const hosts: [ProviderName, string][] = [
      ['github', new URL(env.GITHUB_BASE_URL || 'https://github.com').hostname],
      ['gitlab', new URL(env.GITLAB_BASE_URL || 'https://gitlab.com').hostname],
    ];
    const refs: RepoRef[] = [];
    for (const name of listGitProjects(root(this.config), env.CHECKOUTS_ROOT, env.SWARMLOOP_REPOS)) {
      const path = resolveCheckoutPath(root(this.config), env.CHECKOUTS_ROOT, name, '');
      try {
        const origin = await git(['-C', path, 'remote', 'get-url', 'origin'], undefined, {
          timeoutMs: GIT_LIMITS.query,
        });
        const { host, project } = remoteProject(origin);
        const provider = hosts.find(([, hostname]) => hostname === host)?.[0];
        const cut = project.lastIndexOf('/');
        if (provider && cut > 0) {
          refs.push({ host: provider, owner: project.slice(0, cut), name: project.slice(cut + 1) });
        }
      } catch {
        // a broken checkout must not block a login
      }
    }
    return refs;
  }
}
