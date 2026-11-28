import { existsSync } from 'fs';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConnectionsService } from '../../auth/connections.service';
import { AppConfig } from '../../config/env';
import { assertRepoAllowed, isProjectName, repoAllowed } from '../../config/checkout-path';
import { repositoryPick } from '../../config/repository-pick';
import type { CreateRepositoryBody, RemoteEntry, RemoteListView, RemoteRepository } from '../../contract/api';
import { Clock } from '../../core/clock';
import { isHostOutage, SwarmloopError } from '../../core/swarmloop-error';
import { git, gitDetail } from '../../git/git';
import { withGitHostRetries } from '../../git/host-retry';
import { CheckoutRepository } from '../../history/checkout.repository';
import { codeHostAdapter, codeHostAdapters } from '../../integrations/code-host/code-host-adapters';
import { CodeHostRegistry, type CodeHostName } from '../../integrations/code-host/code-host.registry';
import type { CodeHost } from '../../integrations/code-host/code-host';
import type { RunHosts } from '../../integrations/code-host/run-hosts';
import { CheckoutPlacement, type Placement } from './checkout-placement';
import { type HostSnapshot, RemoteCache } from './remote-cache';

const MAX_PAGES = 20;

/** The listed repositories a value names: `owner/name` by its label, a bare name by its name. */
function named(repositories: RemoteEntry[], value: string): RemoteEntry[] {
  if (repositoryPick(value) === null) {
    return repositories.filter((repository) => repository.name === value);
  }
  return repositories.filter(
    (repository) => `${repository.owner}/${repository.name}`.toLowerCase() === value.toLowerCase(),
  );
}

/** The listed form of a repository in the place it was given. */
function entryOf(repository: RemoteRepository, placed: Placement): RemoteEntry {
  return 'blocked' in placed
    ? { ...repository, cloned: false, blocked: placed.blocked }
    : { ...repository, cloned: placed.cloned };
}

/**
 * The repositories of the connected code hosts, and the clone and create that put them under the checkouts root.
 * A repository is picked by owner and name; its folder is its bare name, or `<name>-<owner>` when another remote holds that.
 */
@Injectable()
export class RemoteRepositories {
  private readonly logger = new Logger(RemoteRepositories.name);
  /** By person and host: each person sees the repositories their own token reaches. */
  private readonly cache: RemoteCache;
  private readonly placement: CheckoutPlacement;

  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly hosts: CodeHostRegistry,
    private readonly checkouts: CheckoutRepository,
    @Optional() private readonly connections?: ConnectionsService,
  ) {
    this.cache = new RemoteCache(clock);
    this.placement = new CheckoutPlacement(config, hosts);
  }

  async list(actor: string | null = null): Promise<RemoteListView> {
    const hosts = await this.hosts.forRun(actor);
    const names = this.configured(hosts);
    if (names.length === 0) {
      return this.noToken();
    }
    const snapshots = await Promise.all(names.map((name) => this.snapshot(hosts, name, actor)));
    return this.view(snapshots, false, null);
  }

  /** The list from the cached snapshots only. */
  async cachedList(actor: string | null): Promise<RemoteListView> {
    const names = this.configured(await this.hosts.forRun(actor));
    if (names.length === 0) {
      return this.noToken();
    }
    const snapshots: HostSnapshot[] = [];
    const errors: string[] = [];
    let loading = false;
    for (const name of names) {
      const snapshot = this.cache.snapshot(actor, name);
      const failure = this.cache.failure(actor, name);
      if (snapshot) {
        snapshots.push(snapshot);
      }
      if (failure !== undefined) {
        errors.push(`${codeHostAdapter(name)?.label ?? name}: ${failure}`);
      } else if (!snapshot) {
        loading = true;
      }
    }
    return this.view(snapshots, loading, errors.length > 0 ? errors.join('; ') : null);
  }

  /**
   * The hosts a refresh is due for: a missing or stale snapshot, no refresh pending, no failure kept.
   * Each one is marked pending in the same step that finds it, so two reads never claim the same host.
   */
  async claimDue(actor: string | null): Promise<CodeHostName[]> {
    const names = this.configured(await this.hosts.forRun(actor));
    const due = names.filter(
      (name) =>
        this.cache.failure(actor, name) === undefined &&
        !this.cache.fresh(actor, name) &&
        !this.cache.isPending(actor, name),
    );
    for (const name of due) {
      this.cache.markPending(actor, name);
    }
    return due;
  }

  clearPending(actor: string | null, host: CodeHostName): void {
    this.cache.clearPending(actor, host);
  }

  /** Reads one host again and keeps the result: the snapshot, or the failure, which is thrown on. */
  async refresh(actor: string | null, host: CodeHostName): Promise<void> {
    try {
      const hosts = await this.hosts.forRun(actor, host);
      this.cache.store(actor, host, await this.read(hosts.byName(host)));
    } catch (error) {
      this.cache.fail(actor, host, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.cache.clearPending(actor, host);
    }
  }

  /** Drops the failures kept for a person, so the next read refreshes those hosts again. */
  retry(actor: string | null): void {
    this.cache.dropFailures(actor);
  }

  /** True when the value, an `owner/name` or a bare name, is a repository of a connected host. */
  async offers(value: string, actor: string | null = null): Promise<boolean> {
    return named((await this.list(actor)).repositories, value).length > 0;
  }

  /** True when a folder of that name is under the checkouts root. A name that cannot be a project or a missing root is left for prepare to report. */
  hasFolder(name: string): boolean {
    if (!isProjectName(name)) {
      return true;
    }
    try {
      return existsSync(this.placement.folder(name));
    } catch (error) {
      if (error instanceof SwarmloopError) {
        return true;
      }
      throw error;
    }
  }

  /**
   * Clones a repository of a connected host, named by `owner/name` or by a bare name no other repository shares, and returns its folder.
   * One that is already cloned is left alone.
   */
  async clone(value: string, actor: string | null): Promise<string> {
    if (repositoryPick(value) === null) {
      assertRepoAllowed(this.config.env.SWARMLOOP_REPOS, value);
    }
    const listed = await this.list(actor);
    if (listed.reason) {
      throw new SwarmloopError(
        `${listed.reason}: Connect ${codeHostAdapters()
          .map((adapter) => adapter.label)
          .join(' or ')}, or set a token in .env`,
      );
    }
    const matches = named(listed.repositories, value);
    const [repository] = matches;
    if (!repository) {
      throw new SwarmloopError(`${value} is not a repository of the connected code hosts`);
    }
    if (matches.length > 1) {
      const owners = matches.map((match) => `${match.owner}/${match.name}`).join(', ');
      throw new SwarmloopError(`${value} matches several repositories: ${owners}`);
    }
    const placed = await this.placement.place(repository);
    if ('blocked' in placed) {
      throw new SwarmloopError(placed.blocked);
    }
    assertRepoAllowed(this.config.env.SWARMLOOP_REPOS, placed.folder);
    if (!placed.cloned) {
      await this.cloneInto(await this.hosts.forRun(actor, repository.host), repository, placed.folder, actor);
    }
    return placed.folder;
  }

  async create(body: CreateRepositoryBody, actor: string | null): Promise<RemoteEntry> {
    const name = body.name.trim();
    if (!isProjectName(name)) {
      throw new SwarmloopError('checkout name is invalid');
    }
    assertRepoAllowed(this.config.env.SWARMLOOP_REPOS, name);
    if (!this.hosts.has(body.host)) {
      throw new SwarmloopError('code host is missing');
    }
    const hosts = await this.hosts.forRun(actor, body.host);
    hosts.requiredCredentials(body.host);
    if (this.hasFolder(name)) {
      throw new SwarmloopError(`${name} already exists as a folder`);
    }
    const { owners } = await this.snapshot(hosts, body.host, actor);
    const owner = owners.find((item) => item.login === body.owner);
    if (!owner) {
      throw new SwarmloopError(`${body.owner} cannot create repositories`);
    }
    const { repository } = await hosts
      .byName(body.host)
      .createRepository({ owner, name, isPublic: body.public === true });
    this.cache.add(actor, body.host, repository);
    if (actor && codeHostAdapter(repository.host)?.ownerFromActor === true) {
      await this.connections?.addRepository(actor, `${repository.owner}/${repository.name}`);
    }
    this.logger.log(`${actor ?? 'nobody'} created ${repository.owner}/${repository.name} on ${repository.host}`);
    await this.cloneInto(hosts, repository, name, actor);
    await this.checkouts.saveCheckout(repository.name, '');
    return { ...repository, cloned: true };
  }

  private async cloneInto(
    hosts: RunHosts,
    repository: RemoteRepository,
    folder: string,
    actor: string | null,
  ): Promise<void> {
    const host = hosts.byName(repository.host);
    const project = `${repository.owner}/${repository.name}`;
    const url = host.cloneUrl(project);
    try {
      await withGitHostRetries(
        url,
        this.clock,
        () => git(['clone', url, this.placement.folder(folder)], host.cloneEnv()),
        host.selected().token,
      );
    } catch (error) {
      if (isHostOutage(error)) {
        throw error;
      }
      throw new SwarmloopError(`clone of ${project} failed: ${gitDetail(error)}`);
    }
    this.logger.log(`${actor ?? 'nobody'} cloned ${project} from ${repository.host}`);
  }

  private configured(hosts: RunHosts): CodeHostName[] {
    return hosts.names.filter((name) => hosts.credentials(name).token.trim() !== '');
  }

  private missingToken(): string {
    return `${this.hosts.names.map((name) => this.hosts.credentials(name).tokenKey).join(' or ')} is missing`;
  }

  /** The repositories and owners of one host, kept for a minute. */
  private async snapshot(hosts: RunHosts, name: string, actor: string | null): Promise<HostSnapshot> {
    const cached = this.cache.fresh(actor, name);
    if (cached) {
      return cached;
    }
    const fresh = await this.read(hosts.byName(name));
    this.cache.store(actor, name, fresh);
    return fresh;
  }

  /** Reads every page of a host's repositories and its owners. */
  private async read(host: CodeHost): Promise<HostSnapshot> {
    const repositories: RemoteRepository[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const read = await host.listRepositories(page);
      repositories.push(...read.repositories);
      if (!read.more) {
        break;
      }
    }
    const { owners } = await host.listOwners();
    return { at: this.clock.now(), repositories, owners };
  }

  private noToken(): RemoteListView {
    return {
      repositories: [],
      owners: [],
      reason: this.missingToken(),
      allowedNames: this.config.env.SWARMLOOP_REPOS,
      loading: false,
      error: null,
    };
  }

  private async view(snapshots: HostSnapshot[], loading: boolean, error: string | null): Promise<RemoteListView> {
    const allowedNames = this.config.env.SWARMLOOP_REPOS;
    const repositories: RemoteEntry[] = [];
    for (const repository of snapshots.flatMap((snapshot) => snapshot.repositories)) {
      // A name the checkouts root would not list as a project cannot be cloned into it.
      if (!isProjectName(repository.name)) {
        continue;
      }
      const placed = await this.placement.place(repository);
      if (repoAllowed(allowedNames, 'folder' in placed ? placed.folder : repository.name)) {
        repositories.push(entryOf(repository, placed));
      }
    }
    return {
      repositories,
      owners: snapshots.flatMap((snapshot) => snapshot.owners),
      reason: null,
      allowedNames,
      loading,
      error,
    };
  }
}
