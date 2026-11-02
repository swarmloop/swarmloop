import { Module } from '@nestjs/common';
import { PipelineModule } from '../pipeline/pipeline.module';
import { FetchCommand } from './fetch.command';
import { RunCommand } from './run.command';
import { StepCommand } from './step.command';

@Module({
  imports: [PipelineModule],
  providers: [FetchCommand, RunCommand, StepCommand],
})
export class CliModule {}
