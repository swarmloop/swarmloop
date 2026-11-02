import { Module } from '@nestjs/common';
import { CliModule } from './cli/cli.module';
import { SwarmloopConfigModule } from './config/config.module';

@Module({
  imports: [SwarmloopConfigModule.forRoot(), CliModule],
})
export class AppModule {}
