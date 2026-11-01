import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HistoryModule } from '../../history/history.module';
import { ISSUE_TRACKER } from '../../providers/tokens';
import { LinkedPagesService } from '../linked-pages/linked-pages';
import { PASTE_READER, PastePageReader, TerminalPasteReader } from '../linked-pages/paste-page.reader';
import { JiraIssueTracker } from './jira/jira-issue-tracker';
import { IssueTrackerRegistry } from './issue-tracker.registry';

@Module({
  imports: [HistoryModule],
  providers: [
    JiraIssueTracker,
    IssueTrackerRegistry,
    PastePageReader,
    LinkedPagesService,
    TerminalPasteReader,
    { provide: PASTE_READER, useExisting: TerminalPasteReader },
    {
      provide: ISSUE_TRACKER,
      useFactory: (config: ConfigService, registry: IssueTrackerRegistry) =>
        registry.byName(config.getOrThrow<string>('ISSUE_TRACKER')),
      inject: [ConfigService, IssueTrackerRegistry],
    },
  ],
  exports: [IssueTrackerRegistry, TerminalPasteReader, ISSUE_TRACKER, PASTE_READER],
})
export class IssueTrackerModule {}
