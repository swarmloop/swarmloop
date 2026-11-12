import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import { listGitProjects, resolveCheckoutPath } from '../config/checkout-path';
import { git, GIT_LIMITS } from '../git/git';
import { root } from '../history/run-paths';
import { remoteProject } from '../integrations/code-host/remote-project';
import type { ProviderName, RepoRef } from './oauth-provider';

/** How long the origins read from the checkouts are reused, so a page load or a login does not rescan them. */
const CACHE_MS = 30_000;

/** The repositories this server works on (`CHECKOUTS_ROOT`, narrowed by `SWARMLOOP_REPOS`), read from their origins. */
@Injectable()
export class CheckoutRepos {
  private cached: { at: number; refs: Promise<RepoRef[]> } | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  /** A checkout with no readable origin, or on another host than GitHub or GitLab, is left out. */
  list(): Promise<RepoRef[]> {
    if (!this.cached || this.clock.now() - this.cached.at > CACHE_MS) {
      this.cached = { at: this.clock.now(), refs: this.read() };
    }
    return this.cached.refs;
  }

  private async read(): Promise<RepoRef[]> {
    const { env } = this.config;
    const hosts: [ProviderName, string][] = [
      ['github', new URL(env.GITHUB_BASE_URL || 'https://github.com').hostname],
      ['gitlab', new URL(env.GITLAB_BASE_URL || 'https://gitlab.com').hostname],
    ];
    const names = listGitProjects(root(this.config), env.CHECKOUTS_ROOT, env.SWARMLOOP_REPOS);
    const refs: RepoRef[] = [];
    for (const name of names) {
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

  /** The owners of the checkouts on a host, the one with most checkouts first and ties in alphabetical order. */
  async owners(host: ProviderName): Promise<string[]> {
    const counts = new Map<string, number>();
    for (const repo of await this.list()) {
      if (repo.host === host) {
        counts.set(repo.owner, (counts.get(repo.owner) ?? 0) + 1);
      }
    }
    return [...counts.keys()].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b));
  }
}
