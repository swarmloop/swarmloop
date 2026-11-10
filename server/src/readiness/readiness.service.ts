import { access, stat } from 'fs/promises';
import { constants } from 'fs';
import { join } from 'path';
import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/env';
import type { ReadinessId, ReadinessItem, ReadinessView } from '../contract/api';
import { FetchFailed } from '../core/swarmloop-error';
import { root } from '../history/run-paths';
import { runtimeFor } from '../integrations/agent-runtime/agent-runtime.registry';
import { CodeHostRegistry } from '../integrations/code-host/code-host.registry';
import { DiskGuard } from '../pipeline/disk-guard';
import { imageName } from '../sandbox/image-resolver';
import { agentImage, sandboxUserId } from '../sandbox/sandbox-launch';
import { SandboxService } from '../sandbox/sandbox.service';

type Outcome = Omit<ReadinessItem, 'id'>;

const GB = 1024 ** 3;
const DASHBOARD_PORT = 3921;
const PROBE_TIMEOUT_MS = 1500;
const NOTHING = 'nothing to do';
const RANK: Record<Outcome['status'], number> = { ok: 0, warn: 1, fail: 2 };

function ok(line: string): Outcome {
  return { status: 'ok', line, action: NOTHING };
}

/** The most severe of several outcomes, with every line kept. */
function worst(outcomes: Outcome[]): Outcome {
  const top = outcomes.reduce((a, b) => (RANK[b.status] > RANK[a.status] ? b : a));
  return { ...top, line: outcomes.map((outcome) => outcome.line).join('; ') };
}

/**
 * Says whether a run can start. Every check only reads: no pull, no write to a remote, no model call.
 * The same report serves `GET /readiness` and `swarmloop doctor`.
 */
@Injectable()
export class ReadinessService {
  constructor(
    private readonly config: AppConfig,
    private readonly sandbox: SandboxService,
    private readonly disk: DiskGuard,
    private readonly hosts: CodeHostRegistry,
  ) {}

  async report(): Promise<ReadinessView> {
    const checks: [ReadinessId, () => Outcome | Promise<Outcome>][] = [
      ['docker', () => this.docker()],
      ['arch', () => this.arch()],
      ['images', () => this.images()],
      ['disk', () => this.diskSpace()],
      ['paths', () => this.paths()],
      ['ports', () => this.ports()],
      ['model-credential', () => this.modelCredential()],
      ['code-host-token', () => this.codeHostToken()],
    ];
    const items = await Promise.all(
      checks.map(async ([id, check]): Promise<ReadinessItem> => {
        try {
          return { id, ...(await check()) };
        } catch (error) {
          const line = error instanceof Error ? error.message : String(error);
          return { id, status: 'fail', line, action: 'fix the cause named in the line, then check again' };
        }
      }),
    );
    return { items };
  }

  private async docker(): Promise<Outcome> {
    try {
      await this.sandbox.run(['info']);
    } catch {
      return { status: 'fail', line: 'docker is not running', action: 'start Docker or mount the Docker socket' };
    }
    return ok('docker answers');
  }

  private arch(): Outcome {
    if (process.arch === 'x64' || process.arch === 'arm64') {
      return ok(`${process.arch} is supported`);
    }
    return { status: 'fail', line: `${process.arch} is not supported`, action: 'use an x64 or arm64 host' };
  }

  private async images(): Promise<Outcome> {
    const { RUNTIME } = this.config.env;
    const wanted = [agentImage(RUNTIME), imageName('egress')];
    return worst(await Promise.all(wanted.map((image) => this.image(image))));
  }

  private async image(image: string): Promise<Outcome> {
    if (await this.present(image)) {
      return ok(`${image} is present`);
    }
    return {
      status: 'fail',
      line: `${image} is missing`,
      action: 'run `docker compose up -d`, it pulls them',
    };
  }

  private async present(ref: string): Promise<boolean> {
    try {
      await this.sandbox.run(['image', 'inspect', ref]);
      return true;
    } catch {
      return false;
    }
  }

  private async diskSpace(): Promise<Outcome> {
    const minimum = this.config.env.MIN_FREE_GB;
    const free = (await this.disk.smallestFree()) / GB;
    const line = `${free.toFixed(1)} GB free, a step needs ${minimum} GB (MIN_FREE_GB)`;
    if (free < minimum) {
      return { status: 'fail', line, action: 'free some disk space or lower MIN_FREE_GB' };
    }
    if (free < minimum * 1.5) {
      return { status: 'warn', line, action: 'free some disk space before long runs' };
    }
    return ok(line);
  }

  private async paths(): Promise<Outcome> {
    const base = root(this.config);
    const owners = new Set([sandboxUserId(), process.getuid?.() ?? 0]);
    const dirs = ['data', 'worktrees'].map((name) => join(base, name));
    const outcomes: Outcome[] = [];
    for (const dir of dirs) {
      outcomes.push(await this.writable(dir, owners));
    }
    const mapped = [...dirs, ...(this.config.env.CHECKOUTS_ROOT ? [this.config.env.CHECKOUTS_ROOT] : [])];
    for (const dir of mapped) {
      outcomes.push(await this.daemonVisible(dir));
    }
    return worst(outcomes);
  }

  /** A directory the sandbox can use is writable and owned by the server user or the user the sandbox runs as. */
  private async writable(dir: string, owners: Set<number>): Promise<Outcome> {
    const fix = `chown the directory to uid ${[...owners].join(' or ')} and make it writable`;
    try {
      await access(dir, constants.W_OK);
      if (!owners.has((await stat(dir)).uid)) {
        return { status: 'fail', line: `${dir} has another owner`, action: fix };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return ok(`${dir} is created on the first run`);
      }
      return { status: 'fail', line: `${dir} is not writable`, action: fix };
    }
    return ok(`${dir} is writable`);
  }

  private async daemonVisible(dir: string): Promise<Outcome> {
    const daemon = await this.sandbox.stateDaemonPath(dir);
    if (!daemon) {
      return {
        status: 'fail',
        line: `${dir} has no path the Docker daemon can see`,
        action: 'mount the directory from the host and mount the Docker socket',
      };
    }
    return ok(`${dir} is ${daemon} for the daemon`);
  }

  private async ports(): Promise<Outcome> {
    const api = this.config.env.SWARMLOOP_API_PORT;
    return worst([await this.port('API', api, true), await this.port('dashboard', DASHBOARD_PORT, false)]);
  }

  /** A port is free when nothing answers, and ours when its listener is swarmloop. */
  private async port(name: string, port: number, apiCheck: boolean): Promise<Outcome> {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      const ours = apiCheck ? ((await response.json()) as { status?: string }).status === 'ok' : true;
      return ours ? ok(`${name} port ${port} is ours`) : this.taken(name, port);
    } catch (error) {
      const code = (error as { cause?: { code?: string } }).cause?.code;
      return code === 'ECONNREFUSED' ? ok(`${name} port ${port} is free`) : this.taken(name, port);
    }
  }

  private taken(name: string, port: number): Outcome {
    return {
      status: 'fail',
      line: `${name} port ${port} is used by another process`,
      action: 'stop the other process or change the port',
    };
  }

  private modelCredential(): Outcome {
    const env = this.config.env;
    const runtime = runtimeFor(env.RUNTIME);
    try {
      const { name } = runtime.credential({
        cursorKey: env.CURSOR_API_KEY,
        anthropicKey: env.ANTHROPIC_API_KEY,
        oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
        codexAuth: env.CODEX_AUTH,
        codexApiKey: env.CODEX_API_KEY,
      });
      return ok(`${name} is set for ${env.RUNTIME}`);
    } catch (error) {
      return {
        status: 'fail',
        line: error instanceof Error ? error.message : String(error),
        action: `set ${runtime.credentialNames.join(' or ')} in .env`,
      };
    }
  }

  private async codeHostToken(): Promise<Outcome> {
    const named = this.hosts.names.filter((name) => this.hosts.credentials(name).token.trim() !== '');
    if (named.length === 0) {
      return {
        status: 'warn',
        line: 'no code host token is set',
        action: 'set GITHUB_TOKEN or GITLAB_TOKEN to publish',
      };
    }
    return worst(await Promise.all(named.map((name) => this.hostToken(name))));
  }

  /** One free, read-only call: who the token belongs to. */
  private async hostToken(name: (typeof this.hosts.names)[number]): Promise<Outcome> {
    const key = this.hosts.credentials(name).tokenKey;
    try {
      await this.hosts.byName(name).readCurrentUser();
    } catch (error) {
      const calls = error instanceof FetchFailed ? error.httpCalls : [];
      if (calls.some((call) => call.statusCode === 401 || call.statusCode === 403)) {
        return { status: 'fail', line: `${key} was rejected`, action: `replace ${key} with a valid token` };
      }
      return { status: 'warn', line: `${key} could not be checked`, action: 'check the network and the base URL' };
    }
    return ok(`${key} is accepted`);
  }
}
