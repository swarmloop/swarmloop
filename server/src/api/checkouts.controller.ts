import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Post } from '@nestjs/common';
import type { CreateRepositoryBody, ProjectListView, RemoteListView } from '../contract/api';
import type { CommandAccepted } from '../contract/command';
import { Actor } from '../auth/actor.decorator';
import { RemoteListService } from './remote-list.service';
import { PrepareStep } from '../steps/prepare/prepare.step';
import { SwarmloopError } from '../core/swarmloop-error';

@Controller('checkouts')
export class CheckoutsController {
  constructor(
    private readonly prepare: PrepareStep,
    private readonly remote: RemoteListService,
  ) {}

  @Get()
  list(): Promise<{ clones: { name: string }[] }> {
    return this.prepare.listClones().then((clones) => ({ clones }));
  }

  @Get('projects')
  projects(): ProjectListView {
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

  @Get('remote')
  listRemote(@Actor() actor: string | null): Promise<RemoteListView> {
    return this.badRequest(() => this.remote.view(actor));
  }

  @Post('remote/refresh')
  @HttpCode(200)
  refreshRemote(@Actor() actor: string | null): Promise<RemoteListView> {
    return this.badRequest(() => this.remote.retry(actor));
  }

  @Post('repositories')
  @HttpCode(202)
  createRepository(
    @Body() body: Partial<CreateRepositoryBody>,
    @Actor() actor: string | null,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<CommandAccepted> {
    return this.badRequest(() => this.remote.create(body, idempotencyKey, actor));
  }

  private async badRequest<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof SwarmloopError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}
