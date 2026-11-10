import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { AppConfig } from '../config/env';
import type { ProjectListView } from '../contract/api';
import { PrepareStep } from '../steps/prepare/prepare.step';
import { SwarmloopError } from '../core/swarmloop-error';

@Controller('checkouts')
export class CheckoutsController {
  constructor(
    private readonly prepare: PrepareStep,
    private readonly config: AppConfig,
  ) {}

  @Get()
  list(): Promise<{ clones: { name: string }[] }> {
    return this.prepare.listClones().then((clones) => ({ clones }));
  }

  @Get('projects')
  projects(): ProjectListView {
    try {
      return { ...this.prepare.listProjects(), split: this.config.env.SPLIT === 'auto' };
    } catch (error) {
      if (error instanceof SwarmloopError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  @Post()
  async add(@Body() body: { name?: string }): Promise<{ name: string }> {
    try {
      return await this.prepare.addClone(body.name ?? '');
    } catch (error) {
      if (error instanceof SwarmloopError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}
