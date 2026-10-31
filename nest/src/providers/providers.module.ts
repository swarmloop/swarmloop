import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HistoryModule } from '../history/history.module';
import { GithubCodeHost } from '../integrations/code-host/github/github-code-host';
import { GitlabCodeHost } from '../integrations/code-host/gitlab/gitlab-code-host';
import { LinkedPagesService } from '../integrations/linked-pages/linked-pages';
import { PASTE_READER, PastePageReader, TerminalPasteReader } from '../integrations/linked-pages/paste-page.reader';
import { SandboxModule } from '../sandbox/sandbox.module';
import { AGENT_RUNNER, AgentProcessRunner } from '../limits/agent-runner';
import { RunStop } from '../limits/run-stop';
import { AgentRequirementsService } from './requirements/agent-requirements.service';
import { DirectRequirementsService } from './requirements/direct-requirements.service';
import { CodeHosts } from './code-hosts';
import { JiraTrackerService } from './jira/jira-tracker.service';
import { ServiceContextService } from './service-context';
import { createIssueTracker, createRequirementsSource } from './provider.factory';
import { ISSUE_TRACKER, REQUIREMENTS_SOURCE } from './tokens';

@Module({
  imports: [HistoryModule, SandboxModule],
  providers: [
    JiraTrackerService,
    GitlabCodeHost,
    GithubCodeHost,
    CodeHosts,
    ServiceContextService,
    DirectRequirementsService,
    AgentRequirementsService,
    AgentProcessRunner,
    RunStop,
    PastePageReader,
    LinkedPagesService,
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
