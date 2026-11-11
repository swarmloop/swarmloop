import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { AppConfig } from '../config/env';
import type { CreateRepositoryBody, ProjectListView, RemoteEntry, RemoteListView } from '../contract/api';
import { Actor } from '../auth/actor.decorator';
import { RemoteRepositories } from '../steps/prepare/remote-repositories.service';
import { PrepareStep } from '../steps/prepare/prepare.step';
import { SwarmloopError } from '../core/swarmloop-error';

@Controller('checkouts')
export class CheckoutsController {
  constructor(
    private readonly prepare: PrepareStep,
    private readonly config: AppConfig,
    private readonly remote: RemoteRepositories,
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

  @Get('remote')
  listRemote(): Promise<RemoteListView> {
    return this.badRequest(() => this.remote.list());
  }

  @Post('repositories')
  createRepository(@Body() body: Partial<CreateRepositoryBody>, @Actor() actor: string | null): Promise<RemoteEntry> {
    return this.badRequest(() =>
      this.remote.create(
        { host: body.host ?? 'github', owner: body.owner ?? '', name: body.name ?? '', public: body.public },
        actor,
      ),
    );
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
