import { Module } from '@nestjs/common';
import { runtimeConnections } from '../integrations/agent-runtime/agent-runtime.registry';
import { CodeHostRegistry } from '../integrations/code-host/code-host.registry';
import { IssueTrackerRegistry } from '../integrations/issue-tracker/issue-tracker.registry';
import { LinkedPagesService } from '../integrations/linked-pages/linked-pages';
import { PastePageReader } from '../integrations/linked-pages/paste-page.reader';
import { HistoryModule } from '../history/history.module';
import { ProvidersModule } from '../integrations/providers.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { AuthModule } from './auth.module';
import { ConnectionCatalog, CONNECTIONS } from './connection-catalog';
import { SandboxConnectionProbe } from './connection-probe';
import { IntegrationConnectionsController } from './integration-connections.controller';

@Module({
  imports: [AuthModule, HistoryModule, ProvidersModule, SandboxModule],
  controllers: [IntegrationConnectionsController],
  providers: [
    ConnectionCatalog,
    PastePageReader,
    LinkedPagesService,
    SandboxConnectionProbe,
    {
      provide: CONNECTIONS,
      useFactory: (trackers: IssueTrackerRegistry, pages: LinkedPagesService, hosts: CodeHostRegistry) => [
        ...runtimeConnections(),
        ...trackers.connections(),
        ...pages.connections(),
        ...hosts.connections(),
      ],
      inject: [IssueTrackerRegistry, LinkedPagesService, CodeHostRegistry],
    },
  ],
})
export class ConnectionCatalogModule {}
