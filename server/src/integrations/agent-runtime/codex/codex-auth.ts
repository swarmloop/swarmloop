import { createHash } from 'crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'fs/promises';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { SwarmloopError } from '../../../core/swarmloop-error';

const TOKEN_URL = 'https://auth.openai.com/oauth/token';
/** OpenAI's public client id for the Codex CLI. */
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DAY_MS = 24 * 60 * 60 * 1000;
/** Codex itself refreshes after about 8 days. The server does it earlier, so no container ever has to. */
export const REFRESH_AFTER_MS = 3 * DAY_MS;
const HARD_LIMIT_MS = 8 * DAY_MS;
const ENV_CREDENTIAL = 'env';
const EXPIRED_ENV =
  'Codex login expired. Run `codex login`, put the new base64 of ~/.codex/auth.json into CODEX_AUTH and restart the server';
const EXPIRED_CONNECTION = 'Codex login expired. Sign in with ChatGPT again from the Codex card (/connections#codex)';

interface AuthFile {
  tokens?: { access_token?: string; refresh_token?: string; id_token?: string; account_id?: string };
  last_refresh?: string;
  [key: string]: unknown;
}

interface CodexAuthDeps {
  fetch: typeof fetch;
  now: () => number;
}

/** The real network, and time read through the app Clock. */
export function codexAuthDeps(clock: { now(): number }): CodexAuthDeps {
  return { fetch: (...args) => fetch(...args), now: () => clock.now() };
}

const queues = new Map<string, Promise<unknown>>();

/**
 * One owner for the ChatGPT login.
 * A refresh token works once. If five containers start with the same stale file, one refreshes and the rest get a 401.
 * So the server keeps the file, refreshes it under a lock, and hands every container a copy that is fresh.
 */
export class CodexAuthStore {
  private readonly logger = new Logger(CodexAuthStore.name);

  constructor(
    private readonly dir: string,
    private readonly deps: CodexAuthDeps,
  ) {}

  /**
   * The base64 of a usable auth.json. `seed` is the stored login of the credential: the CODEX_AUTH value from .env for
   * `env`, or the login a person connected. Each credential keeps its own file under `<dir>/<credential>` and is
   * refreshed on its own.
   */
  current(seed: string, credential: string = ENV_CREDENTIAL): Promise<string> {
    const dir = join(this.dir, credential);
    const isEnv = credential === ENV_CREDENTIAL;
    const load = (): Promise<string> => this.load(dir, seed, isEnv ? EXPIRED_ENV : EXPIRED_CONNECTION, isEnv);
    const previous = queues.get(dir) ?? Promise.resolve();
    const next = previous.then(load, load);
    queues.set(
      dir,
      next.catch(() => undefined),
    );
    return next;
  }

  private async load(dir: string, seed: string, expired: string, isEnv: boolean): Promise<string> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (isEnv) {
      await this.adoptSingleLogin(dir);
    }
    const file = join(dir, 'auth.json');
    const marker = join(dir, 'seed.sha256');
    const hash = createHash('sha256').update(seed).digest('hex');
    let stored = await readText(file);
    let isNew = false;
    if (stored === null || (await readText(marker)) !== hash) {
      isNew = true;
      stored = Buffer.from(seed, 'base64').toString('utf8');
      parse(stored);
      await save(file, stored);
      await save(marker, hash);
    }
    let auth = parse(stored);
    // A login that is new in .env is refreshed at once: if it was already used up elsewhere, the person hears it now,
    // not from five containers that each fail on it.
    if (isNew || this.stale(auth)) {
      try {
        auth = await this.refresh(auth, expired);
        await save(file, JSON.stringify(auth, null, 2));
        this.logger.log('codex login refreshed');
      } catch (error) {
        if (error instanceof SwarmloopError || this.age(auth) > HARD_LIMIT_MS) {
          throw error instanceof SwarmloopError ? error : new SwarmloopError(expired);
        }
        this.logger.warn(`codex login refresh failed, using the saved one: ${String(error)}`);
      }
    }
    return Buffer.from(JSON.stringify(auth), 'utf8').toString('base64');
  }

  /**
   * Before each credential had its own folder, the env login lived straight in the store directory. It moves under
   * `env` once, with the value it was seeded from: its refreshed tokens are the only ones that still work, because the
   * CODEX_AUTH value in .env was spent by the first refresh and a refresh token works once.
   */
  private async adoptSingleLogin(dir: string): Promise<void> {
    if ((await readText(join(dir, 'auth.json'))) !== null) {
      return;
    }
    for (const name of ['auth.json', 'seed.sha256']) {
      try {
        await rename(join(this.dir, name), join(dir, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
  }

  private age(auth: AuthFile): number {
    const at = Date.parse(auth.last_refresh ?? '');
    return Number.isNaN(at) ? Number.POSITIVE_INFINITY : this.deps.now() - at;
  }

  private stale(auth: AuthFile): boolean {
    if (this.age(auth) > REFRESH_AFTER_MS) {
      return true;
    }
    const expires = expiry(auth.tokens?.access_token);
    return expires !== null && expires - this.deps.now() < DAY_MS;
  }

  private async refresh(auth: AuthFile, expired: string): Promise<AuthFile> {
    const token = auth.tokens?.refresh_token;
    if (!token) {
      throw new SwarmloopError(expired);
    }
    const response = await this.deps.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: token }),
    });
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new SwarmloopError(expired);
    }
    if (!response.ok) {
      throw new Error(`token endpoint answered ${response.status}`);
    }
    const body = (await response.json()) as { access_token?: string; refresh_token?: string; id_token?: string };
    if (!body.access_token) {
      throw new Error('token endpoint returned no access token');
    }
    return {
      ...auth,
      tokens: {
        ...auth.tokens,
        access_token: body.access_token,
        refresh_token: body.refresh_token ?? token,
        id_token: body.id_token ?? auth.tokens?.id_token,
      },
      last_refresh: new Date(this.deps.now()).toISOString(),
    };
  }
}

function parse(text: string): AuthFile {
  try {
    const value = JSON.parse(text) as AuthFile;
    if (value && typeof value === 'object' && value.tokens?.refresh_token) {
      return value;
    }
  } catch {
    // reported below
  }
  throw new SwarmloopError('CODEX_AUTH must be the base64 of a ChatGPT auth.json made by `codex login`');
}

function expiry(jwt: string | undefined): number | null {
  const part = jwt?.split('.')[1];
  if (!part) {
    return null;
  }
  try {
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function save(path: string, text: string): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}
