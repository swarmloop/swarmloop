import { Controller, Get } from '@nestjs/common';
import { Actor } from '../auth/actor.decorator';
import type { ReadinessView } from '../contract/readiness';
import { ReadinessService } from '../readiness/readiness.service';

@Controller('readiness')
export class ReadinessController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get()
  report(@Actor() actor: string | null): Promise<ReadinessView> {
    return this.readiness.report(actor);
  }
}
