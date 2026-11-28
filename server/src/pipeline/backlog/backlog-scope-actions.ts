import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { BacklogView } from '../../contract/backlog';
import type { AddRepositoryBody, CreateBacklogBody } from '../../contract/backlog-actions';
import { listGitProjects } from '../../config/checkout-path';
import { AppConfig } from '../../config/env';
import { Clock } from '../../core/clock';
import { SwarmloopError } from '../../core/swarmloop-error';
import { BacklogRepository } from '../../history/backlog.repository';
import { root } from '../../history/run-paths';
import { RemoteRepositories } from '../../steps/prepare/remote-repositories.service';
import { BacklogActionSupport } from './backlog-action-support';
import { clonePicked } from './backlog-clones';
import { BacklogQueries } from './backlog-queries';
import { checkBacklogName, checkMergeMode, checkRepositories } from './backlog-rules';

/** The writes that set what a backlog covers: making it, and adding a repository to its scope. */
@Injectable()
export class BacklogScopeActions {
  constructor(
    private readonly backlogs: BacklogRepository,
    private readonly queries: BacklogQueries,
    private readonly clock: Clock,
    private readonly config: AppConfig,
    private readonly support: BacklogActionSupport,
    private readonly remote: RemoteRepositories,
  ) {}

  /**
   * The picked repositories that are not cloned yet are cloned first, so a backlog stores checkout folders.
   * Adding a repository to a backlog clones its pick the same way.
   */
  async createBacklog(actor: string | null, body: CreateBacklogBody): Promise<BacklogView> {
    const who = this.support.person(actor);
    const name = checkBacklogName(body.name);
    const mergeMode = checkMergeMode(body.mergeMode);
    if ((await this.backlogs.findBacklog(name)) !== null) throw new ConflictException(`backlog ${name} exists`);
    const repositories = checkRepositories(await clonePicked(this.remote, actor, body.repositories), this.checkouts());
    await this.backlogs.transaction(async (writers) => {
      const saved = await writers.saveBacklog({
        name,
        owner: who,
        repositories,
        mergeMode,
        paused: false,
        createdAt: this.clock.iso(),
      });
      await this.support.record(writers, saved.id as number, who, 'create backlog', {
        repositories: repositories.join(', '),
      });
    });
    return this.queries.view(name);
  }

  async addRepository(actor: string | null, name: string, body: AddRepositoryBody): Promise<BacklogView> {
    await this.support.owned(actor, name); // refuses another person before anything is cloned
    const [repository] = checkRepositories(await clonePicked(this.remote, actor, [body.repository]), this.checkouts());
    // The clone can take long, so the scope is read after it: a repository added meanwhile is not overwritten.
    const { who, backlog } = await this.support.owned(actor, name);
    if (backlog.repositories.includes(repository)) return this.queries.view(name);
    await this.backlogs.transaction(async (writers) => {
      await writers.saveBacklog({ ...backlog, repositories: [...backlog.repositories, repository] });
      await this.support.record(writers, backlog.id as number, who, 'add repository', { repository });
    });
    return this.queries.view(name);
  }

  private checkouts(): string[] {
    const { CHECKOUTS_ROOT, SWARMLOOP_REPOS } = this.config.env;
    try {
      return listGitProjects(root(this.config), CHECKOUTS_ROOT, SWARMLOOP_REPOS);
    } catch (error) {
      if (error instanceof SwarmloopError) throw new BadRequestException(error.message);
      throw error;
    }
  }
}
