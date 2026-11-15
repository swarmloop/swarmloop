import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { ConnectionsService } from '../../auth/connections.service';
import { AppConfig } from '../../config/env';
import { Clock } from '../../core/clock';
import { CodeHostRegistry } from './code-host.registry';

@Module({
  imports: [AuthModule],
  providers: [
    {
      provide: CodeHostRegistry,
      useFactory: (config: AppConfig, clock: Clock, connections?: ConnectionsService) =>
        CodeHostRegistry.create(config.env, clock, connections),
      inject: [AppConfig, Clock, { token: ConnectionsService, optional: true }],
    },
  ],
  exports: [CodeHostRegistry],
})
export class CodeHostModule {}
