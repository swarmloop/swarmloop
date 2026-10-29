import { Module } from '@nestjs/common';
import { SwarmloopConfigModule } from '../config/config.module';
import { HistoryModule } from '../history/history.module';
import { LiveGateway } from '../live/live.gateway';
import { LiveModule } from '../live/live.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { ProvidersModule } from '../providers/providers.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { ChatService } from './chat.service';
import { ShellService } from './shell.service';
import { CheckoutsController } from './checkouts.controller';
import { HealthController } from './health.controller';
import { RunsController } from './runs.controller';
import { RunsService } from './runs.service';

@Module({
  imports: [SwarmloopConfigModule.forRoot(), HistoryModule, PipelineModule, LiveModule, ProvidersModule, SandboxModule],
  controllers: [HealthController, RunsController, CheckoutsController],
  providers: [RunsService, ChatService, ShellService, LiveGateway],
})
export class ApiModule {}
