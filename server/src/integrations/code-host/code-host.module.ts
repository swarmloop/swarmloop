import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { AppConfig } from '../../config/env';
import { Clock } from '../../core/clock';
import { CodeHostRegistry } from './code-host.registry';
import { GithubCodeHost } from './github/github-code-host';
import { GitlabCodeHost } from './gitlab/gitlab-code-host';

@Module({
  imports: [AuthModule],
  providers: [
    {
      provide: GithubCodeHost,
      useFactory: (config: AppConfig, clock: Clock) => new GithubCodeHost(config.env, clock),
      inject: [AppConfig, Clock],
    },
    {
      provide: GitlabCodeHost,
      useFactory: (config: AppConfig, clock: Clock) => new GitlabCodeHost(config.env, clock),
      inject: [AppConfig, Clock],
    },
    CodeHostRegistry,
  ],
  exports: [CodeHostRegistry],
})
export class CodeHostModule {}
