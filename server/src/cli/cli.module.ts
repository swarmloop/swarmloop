import { Module } from '@nestjs/common';
import { PipelineModule } from '../pipeline/pipeline.module';
import { ReadinessModule } from '../readiness/readiness.module';
import { DoctorCommand } from './doctor.command';
import { FetchCommand } from './fetch.command';
import { RunCommand } from './run.command';
import { StepCommand } from './step.command';

@Module({
  imports: [PipelineModule, ReadinessModule],
  providers: [DoctorCommand, FetchCommand, RunCommand, StepCommand],
})
export class CliModule {}
