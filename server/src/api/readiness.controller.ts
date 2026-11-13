import { Controller, Get } from '@nestjs/common';
import type { ReadinessView } from '../contract/readiness';
import { ReadinessService } from '../readiness/readiness.service';

@Controller('readiness')
export class ReadinessController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get()
  report(): Promise<ReadinessView> {
    return this.readiness.report();
  }
}
