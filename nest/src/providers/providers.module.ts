import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HistoryModule } from '../history/history.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { AGENT_RUNNER, AgentProcessRunner } from '../limits/agent-runner';
import { RunStop } from '../limits/run-stop';
import { AgentRequirementsService } from './requirements/agent-requirements.service';
import { DirectRequirementsService } from './requirements/direct-requirements.service';
import { CodeHosts } from './code-hosts';
import { GithubHostService } from './github/github-host.service';
import { GitlabHostService } from './gitlab/gitlab-host.service';
import { JiraTrackerService } from './jira/jira-tracker.service';
import { ServiceContextService } from './service-context';
import { createIssueTracker, createRequirementsSource } from './provider.factory';
import { TerminalPasteReader } from './terminal-paste.reader';
import { ISSUE_TRACKER, PASTE_READER, REQUIREMENTS_SOURCE } from './tokens';

@Module({
  imports: [HistoryModule, SandboxModule],
  providers: [
    JiraTrackerService,
    GitlabHostService,
    GithubHostService,
    CodeHosts,
    ServiceContextService,
    DirectRequirementsService,
    AgentRequirementsService,
    AgentProcessRunner,
    RunStop,
    { provide: PASTE_READER, useClass: TerminalPasteReader },
    { provide: AGENT_RUNNER, useExisting: AgentProcessRunner },
    {
      provide: ISSUE_TRACKER,
      useFactory: (config: ConfigService, jira: JiraTrackerService) =>
        createIssueTracker(config.getOrThrow<string>('ISSUE_TRACKER'), jira),
      inject: [ConfigService, JiraTrackerService],
    },
    {
      provide: REQUIREMENTS_SOURCE,
      useFactory: (config: ConfigService, agent: AgentRequirementsService, direct: DirectRequirementsService) =>
        createRequirementsSource(config.getOrThrow<string>('REQUIREMENTS_VIA'), { agent, direct }),
      inject: [ConfigService, AgentRequirementsService, DirectRequirementsService],
    },
  ],
  exports: [ISSUE_TRACKER, CodeHosts, REQUIREMENTS_SOURCE, AGENT_RUNNER, PASTE_READER, ServiceContextService, RunStop],
})
export class ProvidersModule {}
