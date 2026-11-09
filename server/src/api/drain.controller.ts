import { Controller, Get, Post } from '@nestjs/common';
import type { DrainView } from '../contract/api';
import { CommandService } from '../pipeline/command.service';
import { DrainService } from '../pipeline/drain.service';
import { RunRepository } from '../history/run.repository';

@Controller('drain')
export class DrainController {
  constructor(
    private readonly drain: DrainService,
    private readonly commands: CommandService,
    private readonly runs: RunRepository,
  ) {}

  @Post()
  start(): Promise<DrainView> {
    this.drain.start();
    return this.status();
  }

  @Get()
  async status(): Promise<DrainView> {
    const running = (await this.runs.listRuns()).filter((run) => this.runs.held(run)).length;
    return {
      draining: this.drain.draining,
      idle: this.drain.draining && running === 0 && this.commands.pending() === 0,
      running,
    };
  }
}
