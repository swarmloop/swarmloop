import { Module } from '@nestjs/common';
import { SandboxModule } from '../sandbox/sandbox.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { ReadinessModule } from '../readiness/readiness.module';
import { DoctorCommand } from './doctor.command';
import { FetchCommand } from './fetch.command';
import { ModelListsBootstrap } from '../pipeline/model-lists.bootstrap';
import { RunCommand } from './run.command';
import { StepCommand } from './step.command';

@Module({
  imports: [PipelineModule, ReadinessModule, SandboxModule],
  providers: [DoctorCommand, FetchCommand, ModelListsBootstrap, RunCommand, StepCommand],
})
export class CliModule {}
