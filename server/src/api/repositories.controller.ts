import { Controller, Get, NotFoundException, Param, ServiceUnavailableException } from '@nestjs/common';
import { Actor } from '../auth/actor.decorator';
import { repoAllowed } from '../config/checkout-path';
import { AppConfig } from '../config/env';
import type { RepositoryMainView } from '../contract/repository-main';
import { CHECKOUT_NAME } from '../core/checkout-name';
import { FetchFailed, isHostOutage, SwarmloopError } from '../core/swarmloop-error';
import { RepositoryHost } from '../steps/shared/repository-host';

@Controller('repositories')
export class RepositoriesController {
  constructor(
    private readonly host: RepositoryHost,
    private readonly config: AppConfig,
  ) {}

  @Get(':name/main')
  async main(@Actor() actor: string | null, @Param('name') name: string): Promise<RepositoryMainView> {
    if (!CHECKOUT_NAME.test(name) || !repoAllowed(this.config.env.SWARMLOOP_REPOS, name)) {
      throw new NotFoundException(`${name} is not a repository of this server`);
    }
    try {
      return await this.host.main(name, actor);
    } catch (error) {
      if (isHostOutage(error)) throw new ServiceUnavailableException(error.message);
      if (error instanceof SwarmloopError && !(error instanceof FetchFailed)) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }
}
