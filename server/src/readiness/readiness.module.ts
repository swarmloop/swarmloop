import { Module } from '@nestjs/common';
import { ProvidersModule } from '../integrations/providers.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { ReadinessService } from './readiness.service';

@Module({
  imports: [SandboxModule, PipelineModule, ProvidersModule],
  providers: [ReadinessService],
  exports: [ReadinessService],
})
export class ReadinessModule {}
