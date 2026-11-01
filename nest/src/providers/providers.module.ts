import { Module } from '@nestjs/common';
import { HistoryModule } from '../history/history.module';
import { CodeHostModule } from '../integrations/code-host/code-host.module';
import { IssueTrackerModule } from '../integrations/issue-tracker/issue-tracker.module';
import { RequirementsSourceModule } from '../integrations/requirements-source/requirements-source.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { AGENT_RUNNER, AgentProcessRunner } from '../limits/agent-runner';
import { RunStop } from '../limits/run-stop';
import { ServiceContextService } from './service-context';

@Module({
  imports: [HistoryModule, SandboxModule, CodeHostModule, IssueTrackerModule, RequirementsSourceModule],
  providers: [
    ServiceContextService,
    AgentProcessRunner,
    RunStop,
    { provide: AGENT_RUNNER, useExisting: AgentProcessRunner },
  ],
  exports: [IssueTrackerModule, CodeHostModule, RequirementsSourceModule, AGENT_RUNNER, ServiceContextService, RunStop],
})
export class ProvidersModule {}
