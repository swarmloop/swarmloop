import { Module } from '@nestjs/common';
import { ContainerGate } from './container-gate';
import { SandboxService } from './sandbox.service';

@Module({
  providers: [ContainerGate, SandboxService],
  exports: [ContainerGate, SandboxService],
})
export class SandboxModule {}
