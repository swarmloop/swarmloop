import { Module } from '@nestjs/common';
import { HistoryModule } from '../history/history.module';
import { CodeHostModule } from './code-host/code-host.module';
import { IssueTrackerModule } from './issue-tracker/issue-tracker.module';
import { RequirementsSourceModule } from './requirements-source/requirements-source.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { AGENT_RUNNER, AgentProcessRunner } from '../agent/agent-runner';
import { RunStop } from '../agent/run-stop';
import { ServiceContextService } from '../integrations/service-context';

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
