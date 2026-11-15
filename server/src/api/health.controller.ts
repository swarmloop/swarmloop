import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import type { HealthView } from '../contract/server-pause';
import { ContainerGate } from '../sandbox/container-gate';

@Public()
@Controller()
export class HealthController {
  constructor(private readonly gate: ContainerGate) {}

  @Get('health')
  health(): HealthView {
    return { status: 'ok', paused: this.gate.paused(), containers: this.gate.running() };
  }
}
