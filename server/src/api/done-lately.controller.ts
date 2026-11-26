import { Controller, Get } from '@nestjs/common';
import type { DoneLatelyItem } from '../contract/overview-done';
import { DoneLatelyService } from './done-lately.service';

@Controller('overview')
export class DoneLatelyController {
  constructor(private readonly done: DoneLatelyService) {}

  /** The latest finished items, newest finish first. */
  @Get('done')
  list(): Promise<DoneLatelyItem[]> {
    return this.done.items();
  }
}
