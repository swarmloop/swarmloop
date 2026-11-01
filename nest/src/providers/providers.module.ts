import { Module } from '@nestjs/common';
import { HistoryModule } from '../history/history.module';
import { GithubCodeHost } from '../integrations/code-host/github/github-code-host';
import { GitlabCodeHost } from '../integrations/code-host/gitlab/gitlab-code-host';
import { IssueTrackerModule } from '../integrations/issue-tracker/issue-tracker.module';
import { RequirementsSourceModule } from '../integrations/requirements-source/requirements-source.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { AGENT_RUNNER, AgentProcessRunner } from '../limits/agent-runner';
import { RunStop } from '../limits/run-stop';
import { CodeHosts } from './code-hosts';
import { ServiceContextService } from './service-context';

@Module({
  imports: [HistoryModule, SandboxModule, IssueTrackerModule, RequirementsSourceModule],
  providers: [
    GitlabCodeHost,
    GithubCodeHost,
    CodeHosts,
    ServiceContextService,
    AgentProcessRunner,
    RunStop,
    { provide: AGENT_RUNNER, useExisting: AgentProcessRunner },
  ],
  exports: [IssueTrackerModule, CodeHosts, RequirementsSourceModule, AGENT_RUNNER, ServiceContextService, RunStop],
})
export class ProvidersModule {}
