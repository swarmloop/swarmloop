import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HistoryModule } from '../history/history.module';
import { GithubCodeHost } from '../integrations/code-host/github/github-code-host';
import { GitlabCodeHost } from '../integrations/code-host/gitlab/gitlab-code-host';
import { IssueTrackerModule } from '../integrations/issue-tracker/issue-tracker.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { AGENT_RUNNER, AgentProcessRunner } from '../limits/agent-runner';
import { RunStop } from '../limits/run-stop';
import { AgentRequirementsService } from './requirements/agent-requirements.service';
import { DirectRequirementsService } from './requirements/direct-requirements.service';
import { CodeHosts } from './code-hosts';
import { ServiceContextService } from './service-context';
import { createRequirementsSource } from './provider.factory';
import { REQUIREMENTS_SOURCE } from './tokens';

@Module({
  imports: [HistoryModule, SandboxModule, IssueTrackerModule],
  providers: [
    GitlabCodeHost,
    GithubCodeHost,
    CodeHosts,
    ServiceContextService,
    DirectRequirementsService,
    AgentRequirementsService,
    AgentProcessRunner,
    RunStop,
    { provide: AGENT_RUNNER, useExisting: AgentProcessRunner },
    {
      provide: REQUIREMENTS_SOURCE,
      useFactory: (config: ConfigService, agent: AgentRequirementsService, direct: DirectRequirementsService) =>
        createRequirementsSource(config.getOrThrow<string>('REQUIREMENTS_VIA'), { agent, direct }),
      inject: [ConfigService, AgentRequirementsService, DirectRequirementsService],
    },
  ],
  exports: [IssueTrackerModule, CodeHosts, REQUIREMENTS_SOURCE, AGENT_RUNNER, ServiceContextService, RunStop],
})
export class ProvidersModule {}
