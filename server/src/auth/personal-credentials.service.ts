import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { credentialFor } from '../config/agents';
import { Clock } from '../core/clock';
import { rememberSecret } from '../core/redact';
import type { ConnectionCard } from '../contract/connections';
import { IntegrationSecretRepository } from '../history/integration-secret.repository';
import type { Connection } from '../integrations/connection';
import type { RuntimeKeys, RuntimeName } from '../integrations/agent-runtime/agent-runtime';
import { SecretBox } from './secret-box';

const LAST_CHARACTERS = 4;
export const NO_KEYS: RuntimeKeys = { cursorKey: '', anthropicKey: '', oauthToken: '', codexAuth: '', codexApiKey: '' };

interface RuntimeCredential {
  name: string;
  value: string;
  /** The login whose credential this is, or null for the server's env. */
  owner: string | null;
}

/** The secrets a person stored on the Connections page: sealed at rest, opened only to run that person's work. */
@Injectable()
export class PersonalCredentials {
  constructor(
    private readonly rows: IntegrationSecretRepository,
    private readonly box: SecretBox,
    private readonly clock: Clock,
    private readonly config: AppConfig,
  ) {}

  /** Stores the tested fields of a connection, replacing an earlier row of the same person. */
  async store(
    connection: Connection,
    login: string,
    fields: Record<string, string>,
    account: string | null,
  ): Promise<void> {
    const secrets = connection.secrets(fields);
    secrets.forEach(rememberSecret);
    await this.rows.save({
      id: rowId(connection.id, login),
      connection: connection.id,
      login,
      secret: this.box.seal(JSON.stringify(fields)),
      last4: (secrets[0] ?? '').slice(-LAST_CHARACTERS),
      account,
      status: 'ok',
      reason: null,
      savedAt: this.clock.iso(),
    });
  }

  /** The stored fields, or null when the person has none. Only the id is known here, so every non-empty value is remembered. */
  async fields(id: string, login: string): Promise<Record<string, string> | null> {
    const row = await this.rows.find(rowId(id, login));
    if (!row) {
      return null;
    }
    const fields = JSON.parse(this.box.open(row.secret)) as Record<string, string>;
    Object.values(fields).filter(Boolean).forEach(rememberSecret);
    return fields;
  }

  disconnect(id: string, login: string): Promise<void> {
    return this.rows.delete(rowId(id, login));
  }

  markBroken(id: string, login: string, reason: string): Promise<void> {
    return this.rows.update(rowId(id, login), { status: 'broken', reason });
  }

  markWorking(id: string, login: string): Promise<void> {
    return this.rows.update(rowId(id, login), { status: 'ok', reason: null });
  }

  /** The card of a connection for a person; it holds the last four characters and never the secret. */
  async card(connection: Connection, login: string, env: object): Promise<ConnectionCard> {
    const row = await this.rows.find(rowId(connection.id, login));
    const serverDefault = connection.envDefault(env) !== null;
    const base = {
      id: connection.id,
      logo: connection.logo,
      label: connection.label,
      purpose: connection.purpose,
      serverDefault,
      flows: connection.flows(),
    };
    if (row?.status === 'broken') {
      return { ...base, status: 'attention', account: row.account, last4: row.last4, reason: row.reason };
    }
    if (row) {
      return { ...base, status: 'connected', account: row.account, last4: row.last4, reason: null };
    }
    return { ...base, status: serverDefault ? 'connected' : 'not-connected', account: null, last4: null, reason: null };
  }

  /** The credential a runtime launches with: the person's own first, then the server's env. Null when neither exists. */
  async runtimeCredential(runtime: RuntimeName, login: string | null): Promise<RuntimeCredential | null> {
    const own = login === null ? null : await this.ownCredential(runtime, login);
    const found = own ?? this.envCredential(runtime);
    if (found) {
      rememberSecret(found.value);
    }
    return found;
  }

  /** The login when that person has a credential for the runtime, else `env`. */
  async credentialKey(runtime: RuntimeName, login: string | null): Promise<string> {
    return login !== null && (await this.ownCredential(runtime, login)) ? login : 'env';
  }

  private async ownCredential(runtime: RuntimeName, login: string): Promise<RuntimeCredential | null> {
    try {
      const fields = await this.fields(runtime, login);
      return fields ? { ...credentialFor(fields, runtime), owner: login } : null;
    } catch {
      return null;
    }
  }

  private envCredential(runtime: RuntimeName): RuntimeCredential | null {
    try {
      return { ...credentialFor(this.config.env, runtime), owner: null };
    } catch {
      return null;
    }
  }
}

function rowId(connection: string, login: string): string {
  return `${connection}:${login}`;
}
