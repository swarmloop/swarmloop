import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConnectionCatalogModule } from '../auth/connection-catalog.module';
import { SwarmloopConfigModule } from '../config/config.module';
import { HistoryModule } from '../history/history.module';
import { LiveGateway } from './live.gateway';
import { LiveModule } from '../live/live.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { ProvidersModule } from '../integrations/providers.module';
import { ReadinessModule } from '../readiness/readiness.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { CommandHandlers } from './command-handlers';
import { ChatService } from './chat.service';
import { ShellService } from './shell.service';
import { CheckoutsController } from './checkouts.controller';
import { HealthController } from './health.controller';
import { ReadinessController } from './readiness.controller';
import { RunsController } from './runs.controller';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { StatsController } from './stats.controller';
import { SubtaskClose } from './subtask-close';
import { RunCommandsService } from './run-commands.service';
import { RunSubtaskCommandsService } from './run-subtask-commands.service';
import { RunQueriesService } from './run-queries.service';
import { RunRebaseService } from './run-rebase.service';

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
    ReadinessController,
    RunsController,
    CheckoutsController,
    StatsController,
    SettingsController,
  ],
  providers: [
    RunQueriesService,
    RunCommandsService,
    RunSubtaskCommandsService,
    SubtaskClose,
    RunRebaseService,
    ChatService,
    ShellService,
    SettingsService,
    CommandHandlers,
    LiveGateway,
  ],
})
export class ApiModule {}
