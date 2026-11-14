import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { redact, rememberSecret } from '../core/redact';
import type { ConnectionCard, IntegrationCardsView } from '../contract/connections';
import type { Connection, ConnectionTestResult } from '../integrations/connection';
import { SandboxConnectionProbe } from './connection-probe';
import { PersonalCredentials } from './personal-credentials.service';

/** The connections the catalog lists, in order: the registries' own. */
export const CONNECTIONS = Symbol('CONNECTIONS');

/** The Connections page: one card per integration, and the tested save, test and disconnect of a person's credential. */
@Injectable()
export class ConnectionCatalog {
  constructor(
    @Inject(CONNECTIONS) private readonly connections: readonly Connection[],
    private readonly credentials: PersonalCredentials,
    private readonly probe: SandboxConnectionProbe,
    private readonly config: AppConfig,
  ) {}

  /** The cards for a person. Without a person there is no stored status, only the server's own defaults. */
  async list(actor: string | null): Promise<IntegrationCardsView> {
    const login = personOf(actor);
    return { cards: await Promise.all(this.connections.map((connection) => this.card(connection, login))) };
  }

  /** Stores the fields only after the provider accepted them. */
  async save(id: string, actor: string | null, fields: Record<string, string>): Promise<ConnectionCard> {
    const connection = this.find(id);
    const login = this.person(actor);
    if (connection.flows().every((flow) => flow.kind === 'redirect')) {
      throw new BadRequestException(`connect ${connection.label} through its sign-in`);
    }
    const result = await this.run(connection, fields);
    if (!result.ok) {
      throw new BadRequestException(result.message);
    }
    await this.credentials.store(connection, login, fields, result.account);
    return this.card(connection, login);
  }

  /** Tests the stored credential again. A failure shows on the card as attention, with the provider's reason. */
  async test(id: string, actor: string | null): Promise<ConnectionCard> {
    const connection = this.find(id);
    const login = this.person(actor);
    const fields = connection.ownStore
      ? await connection.ownStore.fields(login)
      : await this.credentials.fields(id, login);
    if (!fields) {
      throw new BadRequestException('nothing is connected to test');
    }
    const result = await this.run(connection, fields);
    if (result.ok) {
      if (!connection.ownStore) {
        await this.credentials.markWorking(id, login);
      }
      return this.card(connection, login);
    }
    if (!connection.ownStore) {
      await this.credentials.markBroken(id, login, result.message);
    }
    const card = await this.card(connection, login);
    return connection.ownStore ? { ...card, status: 'attention', reason: result.message } : card;
  }

  async disconnect(id: string, actor: string | null): Promise<{ ok: true }> {
    const connection = this.find(id);
    const login = this.person(actor);
    await (connection.ownStore ? connection.ownStore.disconnect(login) : this.credentials.disconnect(id, login));
    return { ok: true };
  }

  private async card(connection: Connection, login: string | null): Promise<ConnectionCard> {
    const card = await this.credentials.card(connection, login ?? '', this.config.env);
    return login !== null && connection.ownStore ? { ...card, ...(await connection.ownStore.status(login)) } : card;
  }

  /** The test, with the secrets remembered first so that a message that echoes one is masked. */
  private async run(connection: Connection, fields: Record<string, string>): Promise<ConnectionTestResult> {
    connection.secrets(fields).forEach(rememberSecret);
    try {
      const result = await connection.test(fields, this.probe);
      return result.ok ? result : { ok: false, message: redact(result.message, this.config.env) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: redact(message, this.config.env) };
    }
  }

  private find(id: string): Connection {
    const found = this.connections.find((connection) => connection.id === id);
    if (!found) {
      throw new NotFoundException(`${id} is not a connection`);
    }
    return found;
  }

  private person(actor: string | null): string {
    return requirePerson(actor);
  }
}

/** The login of a person, or a 403 for the machine and for nobody. */
export function requirePerson(actor: string | null): string {
  const login = personOf(actor);
  if (login === null) {
    throw new ForbiddenException('Sign in as a person to change a connection');
  }
  return login;
}

function personOf(actor: string | null): string | null {
  return actor && actor !== 'machine' ? actor : null;
}
