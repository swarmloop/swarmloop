import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { remoteProject } from '../../steps/merge-request/merge-request-record';
import { SwarmloopError } from '../../swarmloop-error';
import { CodeHost, SelectedHost } from './code-host';
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
  ) {
    this.hosts = [github, gitlab];
  }

  static create(config: ConfigService): CodeHostRegistry {
    return new CodeHostRegistry(new GithubCodeHost(config), new GitlabCodeHost(config));
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
export function assignCodeHost(run: { codeHost: string }, hosts: readonly (CodeHostName | null)[], replace: boolean): void {
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
