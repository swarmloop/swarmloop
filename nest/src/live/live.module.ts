import { Global, Module } from '@nestjs/common';
import { LiveHub } from './live.hub';

@Global()
@Module({
  providers: [LiveHub],
  exports: [LiveHub],
})
export class LiveModule {}
