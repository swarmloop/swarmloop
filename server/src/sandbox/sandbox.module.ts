import { Module } from '@nestjs/common';
import { VerifyService } from '../verify/verify.service';
import { SandboxService } from './sandbox.service';

@Module({
  providers: [SandboxService, VerifyService],
  exports: [SandboxService, VerifyService],
})
export class SandboxModule {}
