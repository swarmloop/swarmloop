import { existsSync } from 'fs';
import { join, sep } from 'path';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConnectionsService } from '../../auth/connections.service';
import { AppConfig } from '../../config/env';
import { assertRepoAllowed, isProjectName, repoAllowed, resolveCheckoutPath } from '../../config/checkout-path';
import type {
  CreateRepositoryBody,
  RemoteEntry,
  RemoteListView,
  RemoteRepository,
  RepositoryOwner,
} from '../../contract/api';
import { Clock } from '../../core/clock';
import { SwarmloopError } from '../../core/swarmloop-error';
import { git, gitDetail } from '../../git/git';
import { CheckoutRepository } from '../../history/checkout.repository';
import { root } from '../../history/run-paths';
import { CodeHostRegistry, type CodeHostName } from '../../integrations/code-host/code-host.registry';
import { remoteProject } from '../../integrations/code-host/remote-project';

const CACHE_MS = 60_000;
const MAX_PAGES = 20;

interface HostSnapshot {
  at: number;
  repositories: RemoteRepository[];
  owners: RepositoryOwner[];
}

/** The repositories of the connected code hosts, and the clone and create that put them under the checkouts root. */
@Injectable()
export class RemoteRepositories {
  private readonly logger = new Logger(RemoteRepositories.name);
  /** By person and host: each person sees the repositories their own token reaches. */
  private readonly cache = new Map<string, HostSnapshot>();

  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly hosts: CodeHostRegistry,
    private readonly checkouts: CheckoutRepository,
    @Optional() private readonly connections?: ConnectionsService,
  ) {}

  async list(actor: string | null = null): Promise<RemoteListView> {
    const allowedNames = this.config.env.SWARMLOOP_REPOS;
    const hosts = await this.hosts.forRun(actor);
    const names = this.configured(hosts);
    if (names.length === 0) {
      return { repositories: [], owners: [], reason: this.missingToken(), allowedNames };
    }
    const snapshots = await Promise.all(names.map((name) => this.snapshot(hosts, name, actor)));
    const repositories: RemoteEntry[] = [];
    for (const repository of snapshots.flatMap((snapshot) => snapshot.repositories)) {
      // A name the checkouts root would not list as a project cannot be cloned into it.
      if (isProjectName(repository.name) && repoAllowed(allowedNames, repository.name)) {
        repositories.push(await this.entry(repository));
      }
    }
    return { repositories, owners: snapshots.flatMap((snapshot) => snapshot.owners), reason: null, allowedNames };
  }

  /** True when the name is a repository of a connected host. */
  async offers(name: string, actor: string | null = null): Promise<boolean> {
    return (await this.list(actor)).repositories.some((repository) => repository.name === name);
  }

  /** True when a folder of that name is under the checkouts root. A name that cannot be a project or a missing root is left for prepare to report. */
  hasFolder(name: string): boolean {
    if (!isProjectName(name)) {
      return true;
    }
    try {
      return existsSync(this.folder(name));
    } catch (error) {
      if (error instanceof SwarmloopError) {
        return true;
      }
      throw error;
    }
  }

  /** Clones a repository of a connected host into `<checkouts root>/<name>`. One that is already cloned from it is left alone. */
  async clone(name: string, actor: string | null): Promise<void> {
    assertRepoAllowed(this.config.env.SWARMLOOP_REPOS, name);
    const listed = await this.list(actor);
    if (listed.reason) {
      throw new SwarmloopError(`${listed.reason}: Connect GitHub or GitLab, or set a token in .env`);
    }
    const matches = listed.repositories.filter((repository) => repository.name === name);
    if (matches.some((repository) => repository.cloned)) {
      return;
    }
    const [repository] = matches;
    if (!repository) {
      throw new SwarmloopError(`${name} is not a repository of the connected code hosts`);
    }
    if (matches.length > 1) {
      const owners = matches.map((match) => `${match.owner}/${match.name}`).join(', ');
      throw new SwarmloopError(`${name} matches several repositories: ${owners}`);
    }
    if (repository.blocked) {
      throw new SwarmloopError(repository.blocked);
    }
    await this.cloneInto(await this.hosts.forRun(actor, repository.host), repository, actor);
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
    this.cache.delete(`${actor ?? ''}:${body.host}`);
    if (repository.host === 'github' && actor) {
      await this.connections?.addRepository(actor, `${repository.owner}/${repository.name}`);
    }
    this.logger.log(`${actor ?? 'nobody'} created ${repository.owner}/${repository.name} on ${repository.host}`);
    await this.cloneInto(hosts, repository, actor);
    await this.checkouts.saveCheckout(repository.name, '');
    return { ...repository, cloned: true };
  }

  private async cloneInto(hosts: CodeHostRegistry, repository: RemoteRepository, actor: string | null): Promise<void> {
    const host = hosts.byName(repository.host);
    const project = `${repository.owner}/${repository.name}`;
    try {
      await git(['clone', host.cloneUrl(project), this.folder(repository.name)], host.cloneEnv());
    } catch (error) {
      throw new SwarmloopError(`clone of ${project} failed: ${gitDetail(error)}`);
    }
    this.logger.log(`${actor ?? 'nobody'} cloned ${project} from ${repository.host}`);
  }

  /** The folder of a project, which is always inside the checkouts root. */
  private folder(name: string): string {
    const base = resolveCheckoutPath(root(this.config), this.config.env.CHECKOUTS_ROOT, '', '');
    const path = resolveCheckoutPath(root(this.config), this.config.env.CHECKOUTS_ROOT, name, '');
    if (!path.startsWith(`${base}${sep}`)) {
      throw new SwarmloopError(`${name} is not inside the checkouts root`);
    }
    return path;
  }

  private configured(hosts: CodeHostRegistry): CodeHostName[] {
    return hosts.names.filter((name) => hosts.credentials(name).token.trim() !== '');
  }

  private missingToken(): string {
    return `${this.hosts.names.map((name) => this.hosts.credentials(name).tokenKey).join(' or ')} is missing`;
  }

  /** The repositories and owners of one host, kept for a minute. */
  private async snapshot(hosts: CodeHostRegistry, name: CodeHostName, actor: string | null): Promise<HostSnapshot> {
    const slot = `${actor ?? ''}:${name}`;
    const cached = this.cache.get(slot);
    if (cached && this.clock.now() - cached.at < CACHE_MS) {
      return cached;
    }
    const host = hosts.byName(name);
    const repositories: RemoteRepository[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const read = await host.listRepositories(page);
      repositories.push(...read.repositories);
      if (!read.more) {
        break;
      }
    }
    const { owners } = await host.listOwners();
    const fresh = { at: this.clock.now(), repositories, owners };
    this.cache.set(slot, fresh);
    return fresh;
  }

  /** Whether the folder of a repository is a clone of it, or holds the name for another remote. */
  private async entry(repository: RemoteRepository): Promise<RemoteEntry> {
    const path = this.folder(repository.name);
    if (!existsSync(path)) {
      return { ...repository, cloned: false };
    }
    let origin = '';
    if (existsSync(join(path, '.git'))) {
      origin = await git(['-C', path, 'remote', 'get-url', 'origin']).catch(() => '');
    }
    if (origin && this.sameRemote(repository, origin)) {
      return { ...repository, cloned: true };
    }
    return {
      ...repository,
      cloned: false,
      blocked: `${repository.name} already exists as a folder for ${origin || 'no remote'}`,
    };
  }

  private sameRemote(repository: RemoteRepository, origin: string): boolean {
    try {
      return (
        this.hosts.byName(repository.host).matchesOrigin(origin) &&
        remoteProject(origin).project.toLowerCase() === `${repository.owner}/${repository.name}`.toLowerCase()
      );
    } catch {
      return false;
    }
  }
}
