import { Injectable } from '@nestjs/common';
import type { CreateRepositoryBody, RemoteListView } from '../contract/api';
import type { CommandAccepted } from '../contract/command';
import { CommandService } from '../pipeline/command.service';
import { codeHostAdapters } from '../integrations/code-host/code-host-adapters';
import { RemoteRepositories } from '../steps/prepare/remote-repositories.service';
import { acceptCommand } from './run-command-dispatch';

/** The remote list from the cache, and the commands of no run that refresh it and create a repository. */
@Injectable()
export class RemoteListService {
  constructor(
    private readonly remote: RemoteRepositories,
    private readonly commands: CommandService,
  ) {}

  /** Answers the cached list at once and starts one refresh for each host that is due. */
  async view(actor: string | null): Promise<RemoteListView> {
    const due = await this.remote.claimDue(actor);
    for (const [index, host] of due.entries()) {
      try {
        await acceptCommand(this.commands, 'remote-refresh', this.scope(actor), { host }, undefined, actor);
      } catch (error) {
        // The failed host and the hosts not sent yet have no command to end their mark.
        for (const unsent of due.slice(index)) {
          this.remote.clearPending(actor, unsent);
        }
        throw error;
      }
    }
    return this.remote.cachedList(actor);
  }

  /** Drops the kept failures, then reads again like any list. */
  retry(actor: string | null): Promise<RemoteListView> {
    this.remote.retry(actor);
    return this.view(actor);
  }

  create(
    body: Partial<CreateRepositoryBody>,
    idempotencyKey: string | undefined,
    actor: string | null,
  ): Promise<CommandAccepted> {
    const checked: CreateRepositoryBody = {
      host: body.host ?? codeHostAdapters().find((adapter) => adapter.createsByDefault)?.name ?? '',
      owner: body.owner ?? '',
      name: body.name ?? '',
      public: body.public,
    };
    return acceptCommand(this.commands, 'create-repository', this.scope(actor), { ...checked }, idempotencyKey, actor);
  }

  private scope(actor: string | null): string {
    return `repositories:${actor ?? ''}`;
  }
}
