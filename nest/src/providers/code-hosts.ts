import { Injectable } from '@nestjs/common';
import { SwarmloopError } from '../swarmloop-error';
import { CodeHost } from './contracts';
import { GithubHostService } from './github/github-host.service';
import { GitlabHostService } from './gitlab/gitlab-host.service';

@Injectable()
export class CodeHosts {
  constructor(
    private readonly gitlab: GitlabHostService,
    private readonly github: GithubHostService,
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
