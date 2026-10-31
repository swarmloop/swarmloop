import { Injectable } from '@nestjs/common';
import { SwarmloopError } from '../swarmloop-error';
import { CodeHost } from '../integrations/code-host/code-host';
import { GithubCodeHost } from '../integrations/code-host/github/github-code-host';
import { GitlabCodeHost } from '../integrations/code-host/gitlab/gitlab-code-host';

@Injectable()
export class CodeHosts {
  constructor(
    private readonly gitlab: GitlabCodeHost,
    private readonly github: GithubCodeHost,
  ) {}

  get(name: string): CodeHost {
    if (name === 'gitlab') {
      return this.gitlab;
    }
    if (name === 'github') {
      return this.github;
    }
    throw new SwarmloopError('code host is missing');
  }
}
