import { Module } from '@nestjs/common';
import { ContainerGate } from './container-gate';
import { RunningWork } from './running-work';
import { SandboxService } from './sandbox.service';

@Module({
  providers: [ContainerGate, RunningWork, SandboxService],
  exports: [ContainerGate, RunningWork, SandboxService],
})
export class SandboxModule {}
