import { Injectable, Optional } from '@nestjs/common';
import { ConnectionsService } from '../../auth/connections.service';
import { remoteProject } from './remote-project';
import { GitAuthError, SwarmloopError } from '../../core/swarmloop-error';
import { CodeHost, SelectedHost } from './code-host';
import type { CodeHostEnv } from './abstract-code-host';
import type { Clock } from '../../core/clock';
import { GithubCodeHost } from './github/github-code-host';
import { GitlabCodeHost } from './gitlab/gitlab-code-host';

const HOST_NAMES = ['github', 'gitlab'] as const;

@Injectable()
export class CodeHostRegistry {
  readonly names: typeof HOST_NAMES = HOST_NAMES;

  private readonly hosts: readonly [GithubCodeHost, GitlabCodeHost];

  constructor(
    private readonly github: GithubCodeHost,
    private readonly gitlab: GitlabCodeHost,
    @Optional() private readonly connections?: ConnectionsService,
  ) {
    this.hosts = [github, gitlab];
  }

  /**
   * The registry of one run: each host calls with the token of the person who started it. A person without a
   * connection on a host, the machine token, the CLI and nobody keep the token of the environment. A token that cannot
   * be used any more is a `GitAuthError`: the run waits for the person to reconnect.
   */
  async forRun(startedBy: string | null | undefined, codeHost?: string): Promise<CodeHostRegistry> {
    const connections = this.connections;
    if (!connections || !startedBy || startedBy === 'machine') {
      return this;
    }
    // With the host known, only that host's connection counts. Without it a broken connection falls back to the env token.
    const tokenOf = (name: CodeHostName) =>
      codeHost
        ? codeHost === name
          ? connections.tokenFor(name, startedBy)
          : Promise.resolve(null)
        : connections.tokenFor(name, startedBy).catch((error: unknown) => {
            if (error instanceof GitAuthError) return null;
            throw error;
          });
    const [github, gitlab] = await Promise.all([tokenOf('github'), tokenOf('gitlab')]);
    return new CodeHostRegistry(
      github === null ? this.github : this.github.withToken(github),
      gitlab === null ? this.gitlab : this.gitlab.withToken(gitlab),
    );
  }

  /** The host of a run, with the token of its person. A host with no token or url is a refusal. */
  async hostFor(run: { codeHost: string; startedBy: string | null }): Promise<CodeHost> {
    const scoped = await this.forRun(run.startedBy, run.codeHost);
    scoped.requiredCredentials(run.codeHost);
    return scoped.byName(run.codeHost);
  }

  /** The tokens a git process of the server reads, those of the person of a run. */
  async tokensFor(
    startedBy: string | null | undefined,
    codeHost?: string,
  ): Promise<Pick<CodeHostEnv, 'GITHUB_TOKEN' | 'GITLAB_TOKEN'>> {
    const run = await this.forRun(startedBy, codeHost);
    return { GITHUB_TOKEN: run.github.selected().token, GITLAB_TOKEN: run.gitlab.selected().token };
  }

  static create(hosts: CodeHostEnv, clock: Clock): CodeHostRegistry {
    return new CodeHostRegistry(new GithubCodeHost(hosts, clock), new GitlabCodeHost(hosts, clock));
  }

  has(name: string): boolean {
    return this.hosts.some((host) => host.name === name);
  }

  byName(name: string): CodeHost {
    return this.take(name);
  }

  forOrigin(origin: string): CodeHostName | null {
    const matched = this.hosts.filter((host) => host.matchesOrigin(origin));
    if (matched.length > 1) {
      throw new SwarmloopError(`${remoteProject(origin).host.toLowerCase()} matches both code hosts`);
    }
    const found = matched[0];
    return found ? found.name : null;
  }

  credentials(name: string): SelectedHost {
    return this.take(name).selected();
  }

  requiredCredentials(name: string): SelectedHost {
    const host = this.credentials(name);
    if (!host.baseUrl.trim()) {
      throw new SwarmloopError(`${host.baseKey} is missing`);
    }
    if (!host.token.trim()) {
      throw new SwarmloopError(`${host.tokenKey} is missing`);
    }
    try {
      new URL(host.baseUrl);
    } catch {
      throw new SwarmloopError(`${host.baseKey} is not a url`);
    }
    return host;
  }

  /** GitLab's push URL when it can be built, otherwise GitHub's. The token is the one that built the URL, or GitHub's when neither did. */
  pushAuth(origin: string): { url: string | null; token: string } {
    const gitlabUrl = this.gitlab.pushUrl(origin);
    if (gitlabUrl) {
      return { url: gitlabUrl, token: this.gitlab.selected().token };
    }
    return { url: this.github.pushUrl(origin), token: this.github.selected().token };
  }

  private take(name: string): CodeHost {
    const host = this.hosts.find((item) => item.name === name);
    if (!host) {
      throw new SwarmloopError('code host is missing');
    }
    return host;
  }
}

export type CodeHostName = CodeHostRegistry['names'][number];

/** One host for this call. An empty list leaves the stored name alone. */
export function assignCodeHost(
  run: { codeHost: string },
  hosts: readonly (CodeHostName | null)[],
  replace: boolean,
): void {
  const found = [...new Set(hosts.filter((host): host is CodeHostName => host !== null))].sort();
  if (found.length > 1) {
    throw new SwarmloopError(`origins use ${found.join(' and ')}`);
  }
  const host = found[0];
  if (!host) {
    return;
  }
  if (!replace && run.codeHost && run.codeHost !== host) {
    throw new SwarmloopError(`origin is not ${run.codeHost}`);
  }
  run.codeHost = host;
}
