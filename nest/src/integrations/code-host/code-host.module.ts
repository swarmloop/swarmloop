import { Module } from '@nestjs/common';
import { CodeHostRegistry } from './code-host.registry';
import { GithubCodeHost } from './github/github-code-host';
import { GitlabCodeHost } from './gitlab/gitlab-code-host';

@Module({
  providers: [GithubCodeHost, GitlabCodeHost, CodeHostRegistry],
  exports: [CodeHostRegistry],
})
export class CodeHostModule {}
