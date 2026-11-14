import type { ConnectionsService } from '../../auth/connections.service';
import type { Endpoints, ProviderName } from '../../auth/oauth-provider';
import { GitAuthError } from '../../core/swarmloop-error';
import type { ConnectionFlow } from '../../contract/connections';
import type { Connection, ConnectionOwnStore, ConnectionProbe, ConnectionTestResult } from '../connection';

interface HostDescription {
  host: ProviderName;
  label: string;
  purpose: string;
  /** The env name of the server's own token for this host. */
  tokenKey: string;
}

/** A code host on the Connections page: its login keeps the tokens in the store of f18, and the card sends the person to that login. */
export class CodeHostConnection implements Connection {
  readonly id: string;
  readonly logo: string;
  readonly label: string;
  readonly purpose: string;
  readonly ownStore: ConnectionOwnStore;

  constructor(
    private readonly description: HostDescription,
    private readonly endpoints: Endpoints,
    private readonly store: ConnectionsService,
  ) {
    this.id = description.host;
    this.logo = description.host;
    this.label = description.label;
    this.purpose = description.purpose;
    this.ownStore = {
      status: (login) => this.status(login),
      disconnect: (login) => this.store.disconnect(description.host, login),
      fields: (login) => this.fields(login),
    };
  }

  flows(): ConnectionFlow[] {
    return [
      {
        kind: 'redirect',
        label: `Sign in with ${this.label}`,
        fields: [],
        helpUrl: null,
        url: `/auth/${this.description.host}/login`,
      },
    ];
  }

  envDefault(env: object): boolean {
    return Boolean((env as Record<string, unknown>)[this.description.tokenKey]);
  }

  secrets(fields: Record<string, string>): string[] {
    return fields.token ? [fields.token] : [];
  }

  async test(fields: Record<string, string>, probe: ConnectionProbe): Promise<ConnectionTestResult> {
    if (!fields.token) {
      return { ok: false, message: `Reconnect ${this.label}` };
    }
    const { api, user } = this.endpoints;
    const answer = await probe.request(`${api}${user.path}`, this.endpoints.userHeaders(fields.token));
    if (answer.status < 200 || answer.status >= 300) {
      return { ok: false, message: `${this.label} answered ${answer.status}` };
    }
    const account = (JSON.parse(answer.body) as Record<string, unknown>)[user.field];
    return { ok: true, account: typeof account === 'string' ? account : null };
  }

  private async status(login: string): ReturnType<ConnectionOwnStore['status']> {
    const health = await this.store.health(this.description.host, login);
    if (!health) {
      return { status: 'not-connected', account: null, reason: null };
    }
    if (health.status === 'broken') {
      return { status: 'attention', account: health.login, reason: `Sign in with ${this.label} again` };
    }
    return { status: 'connected', account: health.login, reason: null };
  }

  /** The token, or an empty one when it cannot be used any more, which a test reports as a failure. */
  private async fields(login: string): Promise<Record<string, string> | null> {
    if (!(await this.store.health(this.description.host, login))) {
      return null;
    }
    try {
      return { token: (await this.store.tokenFor(this.description.host, login)) ?? '' };
    } catch (error) {
      if (error instanceof GitAuthError) {
        return { token: '' };
      }
      throw error;
    }
  }
}
