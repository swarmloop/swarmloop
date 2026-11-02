import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { PrepareStep } from '../steps/prepare/prepare.step';
import { SwarmloopError } from '../core/swarmloop-error';

@Controller('checkouts')
export class CheckoutsController {
  constructor(private readonly prepare: PrepareStep) {}

  @Get()
  list(): Promise<{ clones: { name: string }[] }> {
    return this.prepare.listClones().then((clones) => ({ clones }));
  }

  @Get('projects')
  projects(): { projects: string[] } {
    try {
      return this.prepare.listProjects();
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
