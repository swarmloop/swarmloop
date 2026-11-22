import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConnectionCatalogModule } from '../auth/connection-catalog.module';
import { SwarmloopConfigModule } from '../config/config.module';
import { HistoryModule } from '../history/history.module';
import { LiveGateway } from './live.gateway';
import { RunUsageReader } from './run-usage';
import { LiveModule } from '../live/live.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { RepositoryOrigins } from '../steps/shared/repository-origins';
import { ProvidersModule } from '../integrations/providers.module';
import { ReadinessModule } from '../readiness/readiness.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { CommandHandlers } from './command-handlers';
import { ChatService } from './chat.service';
import { PlanChatController } from './plan-chat.controller';
import { UploadsController } from './uploads.controller';
import { PlanChatService } from './plan-chat.service';
import { ShellService } from './shell.service';
import { BacklogChatController } from './backlog-chat.controller';
import { BacklogChatService } from './backlog-chat.service';
import { BacklogsController } from './backlogs.controller';
import { CheckoutsController } from './checkouts.controller';
import { HealthController } from './health.controller';
import { ReadinessController } from './readiness.controller';
import { RepositoriesController } from './repositories.controller';
import { RunsController } from './runs.controller';
import { ServerController } from './server.controller';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { StatsController } from './stats.controller';
import { SubtaskClose } from './subtask-close';
import { BacklogStart } from './backlog-start';
import { PlannerRunCommands } from './planner-run-commands';
import { RunAnswersService } from './run-answers.service';
import { RunCommandsService } from './run-commands.service';
import { RunSubtaskCommandsService } from './run-subtask-commands.service';
import { RunQueriesService } from './run-queries.service';
import { RunListRows } from './run-list-rows';
import { EtaSummary } from './eta-summary';
import { RunRebaseService } from './run-rebase.service';
import { RequestTiming } from './request-timing';

@Module({
  imports: [
    SwarmloopConfigModule.forRoot(),
    HistoryModule,
    AuthModule,
    ConnectionCatalogModule,
    PipelineModule,
    LiveModule,
    ProvidersModule,
    SandboxModule,
    ReadinessModule,
  ],
  controllers: [
    HealthController,
    ServerController,
    ReadinessController,
    RunsController,
    PlanChatController,
    UploadsController,
    BacklogsController,
    BacklogChatController,
    CheckoutsController,
    RepositoriesController,
    StatsController,
    SettingsController,
  ],
  providers: [
    RunQueriesService,
    RunListRows,
    EtaSummary,
    RunCommandsService,
    RunAnswersService,
    BacklogStart,
    PlannerRunCommands,
    BacklogChatService,
    RunSubtaskCommandsService,
    SubtaskClose,
    RunRebaseService,
    ChatService,
    PlanChatService,
    ShellService,
    RepositoryOrigins,
    SettingsService,
    CommandHandlers,
    RunUsageReader,
    LiveGateway,
    RequestTiming,
  ],
})
export class ApiModule {}
