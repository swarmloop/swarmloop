import { CODE_HOST_ENV_KEYS } from '../../../config/env.schema';
import { SwarmloopError } from '../../../core/swarmloop-error';
import { AbstractCodeHost, type CodeHostEnv } from '../abstract-code-host';
import type { CodeHostAdapter } from '../code-host-adapter';
import { CodeHostConnection } from '../code-host-connection';
import type { SelectedHost } from '../code-host';
import { remotePushRejection, type CodeHostRules } from '../host-rules';
import { HttpOAuthProvider } from '../http-login-provider';
import type { Endpoints } from '../login-provider';

/** A made-up third host. It has no index module, so the registry never finds it; a spec passes it to the contract itself. */
const NAME = 'forge';
const LABEL = 'Forge';

/** The fake reuses two env keys of the shared env shape, because the shape has no keys of a third host. */
const [BASE_KEY, TOKEN_KEY] = CODE_HOST_ENV_KEYS;

/** The base url its fake HTTP answers for. */
const FAKE_THIRD_BASE = 'https://forge.example';

const rules: CodeHostRules = {
  name: NAME,
  label: LABEL,
  ciFiles: ['.forge-ci.yml'],
  pushRejection: remotePushRejection,
  classifyCall: (url) => (new URL(url).pathname.startsWith('/api/v1/') ? NAME : null),
};

function endpointsOf(base: string): Endpoints {
  const root = base.replace(/\/$/, '');
  return {
    appLabel: 'Integration',
    installs: false,
    authorize: `${root}/auth/authorize`,
    token: `${root}/auth/token`,
    api: `${root}/api/v1`,
    scope: 'profile teams',
    userHeaders: (token) => ({ Authorization: `Bearer ${token}` }),
    user: { path: '/me', field: 'handle' },
    groups: { path: '/me/teams', field: 'slug' },
    repoPath: (ref) => `/repos/${ref.owner}~${ref.name}`,
    pushes: (row) => row.can_push === true,
  };
}

function unsupported(): never {
  throw new SwarmloopError('the fake host does not serve this call');
}

/** A host that holds a token and nothing else: the contract only reads its secrets and its login. */
class FakeThirdCodeHost extends AbstractCodeHost {
  readonly name = NAME;
  readonly label = LABEL;
  readonly ciFiles = rules.ciFiles;
  protected readonly repositories = {
    gitUser: 'forge',
    needs: 'repo',
    listUrl: unsupported,
    repositoryOf: unsupported,
    readOwners: unsupported,
    createRequest: unsupported,
  };
  protected readonly states = { stateOf: unsupported };

  constructor(env: CodeHostEnv, clock: ConstructorParameters<typeof AbstractCodeHost>[1]) {
    super(env, clock, 'forge request failed', 'forge rejected the token');
  }

  classifyCall(url: string): string | null {
    return rules.classifyCall(url);
  }

  pushRejection(lines: string[]): string | undefined {
    return rules.pushRejection(lines);
  }

  selected(): SelectedHost {
    return {
      name: NAME,
      baseUrl: this.env[BASE_KEY],
      token: this.env[TOKEN_KEY],
      baseKey: BASE_KEY,
      tokenKey: TOKEN_KEY,
    };
  }

  protected credentialKeys(): readonly (keyof CodeHostEnv)[] {
    return [BASE_KEY, TOKEN_KEY];
  }

  protected endpoint(env: CodeHostEnv): { root: string; headers: Record<string, string> } {
    return { root: `${env[BASE_KEY]}/api/v1`, headers: { Authorization: `Bearer ${env[TOKEN_KEY]}` } };
  }

  diagnoseMissingPipeline(): never {
    return unsupported();
  }
  startPipeline(): never {
    return unsupported();
  }
  setDraft(): never {
    return unsupported();
  }
  cloneUrl(): never {
    return unsupported();
  }
  readBranchPipeline(): never {
    return unsupported();
  }
  readJobTrace(): never {
    return unsupported();
  }
  cancelPipeline(): never {
    return unsupported();
  }
  rerunFailedJobs(): never {
    return unsupported();
  }
  readDefaultHead(): never {
    return unsupported();
  }
  readRunNotes(): never {
    return unsupported();
  }
  matchesOrigin(): never {
    return unsupported();
  }
  pushUrl(): never {
    return unsupported();
  }
  protected userUrl(): never {
    return unsupported();
  }
  protected findUrl(): never {
    return unsupported();
  }
  protected openRequest(): never {
    return unsupported();
  }
  protected updateRequest(): never {
    return unsupported();
  }
  protected mergeRequestUrl(): never {
    return unsupported();
  }
  protected mergeCall(): never {
    return unsupported();
  }
  protected closeCall(): never {
    return unsupported();
  }
  protected deleteCall(): never {
    return unsupported();
  }
  protected view(): never {
    return unsupported();
  }
  protected gate(): never {
    return unsupported();
  }
  protected mergedSha(): never {
    return unsupported();
  }
  protected mergeConflicts(): never {
    return unsupported();
  }
  protected match(): never {
    return unsupported();
  }
  protected record(): never {
    return unsupported();
  }
  protected conflict(): never {
    return unsupported();
  }
}

export const fakeThirdAdapter: CodeHostAdapter = {
  name: NAME,
  label: LABEL,
  baseKey: BASE_KEY,
  tokenKey: TOKEN_KEY,
  tokenPrefixes: ['frg_'],
  create: (env, clock) => new FakeThirdCodeHost(env, clock),
  rules,
  connection: (host, store) =>
    new CodeHostConnection(
      { host: NAME, label: LABEL, purpose: 'Clones and pushes as you', tokenKey: host.tokenKey },
      endpointsOf(host.baseUrl),
      store,
    ),
  pushOrder: 2,
  createsByDefault: false,
  packageHosts: [],
  setupDownloads: [],
  publicHost: 'forge.example',
  appLabel: 'Integration',
  allowPrefixes: { user: 'forge:', group: 'forge-team:' },
  clientEnvKeys: { clientId: 'GITLAB_OAUTH_CLIENT_ID', clientSecret: 'GITLAB_OAUTH_CLIENT_SECRET' },
  keepsTokensWithoutApp: false,
  storesApplication: false,
  ownerFromActor: false,
  endpoints: (env) => endpointsOf(env[BASE_KEY]),
  login: (env, clock, apps, appFlow) =>
    new HttpOAuthProvider(fakeThirdAdapter, fakeThirdAdapter.endpoints(env), env[TOKEN_KEY], clock, apps, appFlow),
};

/** What a host's fake HTTP says: where each call goes and what it answers. A script serves one adapter. */
export interface HostScript {
  base: string;
  /** The end of the url of each call the login makes. */
  paths: { token: string; user: string; groups: string; repo: string };
  /** The login name the user call answers with. */
  owner: string;
  avatarUrl: string;
  groups: string[];
  /** The answer of the user call. */
  userBody(): unknown;
  groupsBody(): unknown;
  /** The repository row, for a token that can push or one that cannot. */
  repoBody(push: boolean): unknown;
}

export const fakeThirdScript: HostScript = {
  base: FAKE_THIRD_BASE,
  paths: { token: '/auth/token', user: '/api/v1/me', groups: '/api/v1/me/teams', repo: '/api/v1/repos/acme~demo' },
  owner: 'robin',
  avatarUrl: 'https://forge.example/avatars/robin.png',
  groups: ['core', 'ops'],
  userBody: () => ({ handle: 'robin', avatar_url: 'https://forge.example/avatars/robin.png' }),
  groupsBody: () => [{ slug: 'core' }, { slug: 'ops' }],
  repoBody: (push) => ({ can_push: push }),
};

/** A response as `fetch` returns it, for the HTTP layer of the adapters. */
export function fakeResponse(status: number, payload: unknown): unknown {
  return {
    status,
    ok: status >= 200 && status < 300,
    url: 'https://forge.example',
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    arrayBuffer: () => Promise.resolve(Buffer.from(JSON.stringify(payload))),
  };
}
