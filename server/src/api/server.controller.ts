import { Controller, Delete, Post } from '@nestjs/common';
import type { ServerState } from '../contract/server-pause';
import { ContainerGate } from '../sandbox/container-gate';

@Controller('server')
export class ServerController {
  constructor(private readonly gate: ContainerGate) {}

  @Post('pause')
  pause(): ServerState {
    this.gate.pause();
    return { paused: true };
  }

  @Delete('pause')
  resume(): ServerState {
    this.gate.resume();
    return { paused: false };
  }
}
