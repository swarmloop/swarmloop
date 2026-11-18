import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { HistoryModule } from '../history/history.module';
import { ProvidersModule } from '../integrations/providers.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { ReadinessModelCredential } from './readiness-model-credential';
import { ReadinessStalls } from './readiness-stalls';
import { ReadinessService } from './readiness.service';

@Module({
  imports: [SandboxModule, PipelineModule, ProvidersModule, AuthModule, HistoryModule],
  providers: [ReadinessService, ReadinessModelCredential, ReadinessStalls],
  exports: [ReadinessService],
})
export class ReadinessModule {}
