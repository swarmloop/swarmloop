import { credentialFor, runtimesInUse } from '../config/agents';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { AppConfig } from '../config/env';
import type { ReadinessId, ReadinessItem, ReadinessView } from '../contract/readiness';
import { Clock } from '../core/clock';
import { FetchFailed } from '../core/swarmloop-error';
import { type RuntimeName } from '../integrations/agent-runtime/agent-runtime.registry';
import { ConnectionsService } from '../auth/connections.service';
import { codeHostAdapters } from '../integrations/code-host/code-host-adapters';
import { CodeHostRegistry } from '../integrations/code-host/code-host.registry';
import { ReadinessModelCredential } from './readiness-model-credential';
import { ReadinessPaths } from './readiness-paths';
import { ReadinessStalls } from './readiness-stalls';
import { missingModelCredential, ok, worst, type Outcome } from './readiness-outcome';
import { DiskGuard } from '../pipeline/disk-guard';
import { OwnUseMeter } from '../pipeline/own-use-meter';
import { readDockerEngine } from '../sandbox/docker-machine';
import { CHECK_CORES, checksAtOnce, sliceSize } from '../sandbox/core-slices';
import { imageName } from '../sandbox/image-resolver';
import { agentImage } from '../sandbox/sandbox-launch';
import { SandboxService } from '../sandbox/sandbox.service';

const GB = 1024 ** 3;
/** The first Docker Engine that mounts a volume subpath. */
const MIN_ENGINE_MAJOR = 26;
const DASHBOARD_PORT = 3921;
const PROBE_TIMEOUT_MS = 1500;
/** How long the report waits for a host whose calls are being retried. */
const HOST_WAIT_MS = 5000;
/** A report older than this starts a refresh in the background. */
const STALE_MS = 60_000;
/** How long the first report is waited for. */
const FIRST_WAIT_MS = 1000;
/**
 * Says whether a run can start. Every check only reads: no pull, no write to a remote, no model call.
 * The same report serves `GET /readiness` and `swarmloop doctor`.
 */
@Injectable()
export class ReadinessService {
  private readonly logger = new Logger(ReadinessService.name);
  private cached: { report: ReadinessView; at: number } | null = null;
  private building: Promise<ReadinessView> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly sandbox: SandboxService,
    private readonly disk: DiskGuard,
    private readonly hosts: CodeHostRegistry,
    private readonly clock: Clock,
    private readonly meter: OwnUseMeter,
    private readonly folders: ReadinessPaths,
    @Optional() private readonly connections?: ConnectionsService,
    @Optional() private readonly person?: ReadinessModelCredential,
    @Optional() private readonly stalls?: ReadinessStalls,
  ) {}

  /** The last full report at once; one that is stale starts a refresh in the background. The first call waits at most 1 s. */
  async report(login: string | null = null): Promise<ReadinessView> {
    const report = await this.envReport();
    const own = login ? await this.person?.outcome(login) : undefined;
    if (!own || !report.items.some((item) => item.id === 'model-credential')) {
      return report;
    }
    return {
      ...report,
      items: report.items.map((item) => (item.id === 'model-credential' ? { id: item.id, ...own } : item)),
    };
  }

  private async envReport(): Promise<ReadinessView> {
    if (this.cached) {
      if (this.clock.now() - this.cached.at >= STALE_MS) {
        void this.refresh().catch((error) => this.logger.warn(`readiness refresh failed: ${String(error)}`));
      }
      return this.cached.report;
    }
    try {
      return await withinWait(this.refresh(), FIRST_WAIT_MS);
    } catch {
      return { items: [], checkedAt: null };
    }
  }

  /** Measures the sizes once and builds a report, for `swarmloop doctor`. The cached report stays as it is. */
  async fresh(): Promise<ReadinessView> {
    await Promise.all([this.meter.measure(), this.sandbox.machine()]);
    return this.build();
  }

  /** One build at a time, shared by every caller; it fills the cache when it ends. */
  private refresh(): Promise<ReadinessView> {
    this.building ??= this.build()
      .then((report) => {
        this.cached = { report, at: this.clock.now() };
        return report;
      })
      .finally(() => {
        this.building = null;
      });
    return this.building;
  }

  private async build(): Promise<ReadinessView> {
    const checks: [ReadinessId, () => Outcome | Promise<Outcome>][] = [
      ['docker', () => this.docker()],
      ['arch', () => this.arch()],
      ['images', () => this.images()],
      ['disk', () => this.diskSpace()],
      ['paths', () => this.folders.outcome()],
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
          return {
            id,
            status: 'fail',
            line,
            short: 'check failed',
            action: 'fix the cause named in the line, then check again',
          };
        }
      }),
    );
    const stalls = await this.stallItem();
    return { items: stalls ? [...items, stalls] : items, checkedAt: this.clock.iso() };
  }

  private async stallItem(): Promise<ReadinessItem | null> {
    try {
      const outcome = await this.stalls?.outcome();
      return outcome ? { id: 'stalls', ...outcome } : null;
    } catch (error) {
      const line = error instanceof Error ? error.message : String(error);
      return {
        id: 'stalls',
        status: 'warn',
        line,
        short: 'check failed',
        action: 'fix the cause named in the line, then check again',
      };
    }
  }

  private async docker(): Promise<Outcome> {
    try {
      await this.sandbox.run(['info']);
    } catch {
      return {
        status: 'fail',
        line: 'docker is not running',
        short: 'not running',
        action: 'start Docker or mount the Docker socket',
      };
    }
    const version = await readDockerEngine((args) => this.sandbox.run(args));
    if (version !== undefined && Number.parseInt(version, 10) < MIN_ENGINE_MAJOR) {
      return {
        status: 'fail',
        short: 'too old',
        line: `Docker Engine ${version} cannot mount a volume subpath; swarmloop needs Engine ${MIN_ENGINE_MAJOR} or newer`,
        action: `update Docker to Engine ${MIN_ENGINE_MAJOR} or newer`,
      };
    }
    const machine = this.sandbox.knownMachine();
    if (!machine) {
      return ok('docker answers', 'running');
    }
    const gb = Number((machine.memoryBytes / GB).toFixed(1));
    const asked = this.config.env.CHECKS_PARALLEL;
    const fit = checksAtOnce(machine.cpus, asked);
    const size = sliceSize(machine.cpus, fit);
    const note =
      asked > fit
        ? ` (CHECKS_PARALLEL ${asked}; ${fit} ${fit === 1 ? 'fits' : 'fit'} with ${CHECK_CORES} cores each)`
        : '';
    const short = `${machine.cpus} CPUs · ${gb} GB · ${fit} ${fit === 1 ? 'check' : 'checks'} × ${size} ${size === 1 ? 'core' : 'cores'}`;
    return ok(`${short}${note}`, short);
  }

  private arch(): Outcome {
    if (process.arch === 'x64' || process.arch === 'arm64') {
      return ok(`${process.arch} is supported`, process.arch);
    }
    return {
      status: 'fail',
      line: `${process.arch} is not supported`,
      short: process.arch,
      action: 'use an x64 or arm64 host',
    };
  }

  private async images(): Promise<Outcome> {
    const wanted = [...runtimesInUse(this.config.env).map(agentImage), imageName('egress')];
    const outcomes = await Promise.all(wanted.map((image) => this.image(image)));
    const missing = outcomes.filter((outcome) => outcome.status !== 'ok').length;
    return worst(outcomes, missing > 0 ? `${missing} missing` : `${outcomes.length} present`);
  }

  private async image(image: string): Promise<Outcome> {
    if (await this.present(image)) {
      return ok(`${image} is present`, 'present');
    }
    return {
      status: 'fail',
      line: `${image} is missing`,
      short: 'missing',
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
    const last = this.meter.last();
    const line = `${free.toFixed(1)} GB free, a step needs ${minimum} GB (MIN_FREE_GB); ${last ? `${last.line}, ${this.age(last.at)}` : 'sizes not measured yet'}`;
    const ownUse = last ? `${last.parts}, ${this.age(last.at)}` : 'sizes not measured yet';
    const short = `${free.toFixed(1)} GB free`;
    if (free < minimum) {
      return { status: 'fail', line, short, ownUse, action: 'free some disk space or lower MIN_FREE_GB' };
    }
    if (free < minimum * 1.5) {
      return { status: 'warn', line, short, ownUse, action: 'free some disk space before long runs' };
    }
    return { ...ok(line, short), ownUse };
  }

  /** How long ago the sizes were measured, in words. */
  private age(at: number): string {
    const minutes = Math.floor((this.clock.now() - at) / 60_000);
    return minutes < 1 ? 'measured just now' : `measured ${minutes} min ago`;
  }

  private async ports(): Promise<Outcome> {
    const api = this.config.env.SWARMLOOP_API_PORT;
    return worst(
      [await this.port('API', api, true), await this.port('dashboard', DASHBOARD_PORT, false)],
      [api, DASHBOARD_PORT].join(' · '),
    );
  }

  /** A port is free when nothing answers, and ours when its listener is swarmloop. */
  private async port(name: string, port: number, apiCheck: boolean): Promise<Outcome> {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      const ours = apiCheck ? ((await response.json()) as { status?: string }).status === 'ok' : true;
      return ours ? ok(`${name} port ${port} is ours`, String(port)) : this.taken(name, port);
    } catch (error) {
      const code = (error as { cause?: { code?: string } }).cause?.code;
      return code === 'ECONNREFUSED' ? ok(`${name} port ${port} is free`, String(port)) : this.taken(name, port);
    }
  }

  private taken(name: string, port: number): Outcome {
    return {
      status: 'fail',
      line: `${name} port ${port} is used by another process`,
      short: String(port),
      action: 'stop the other process or change the port',
    };
  }

  /** The credential of every runtime a role names, one outcome each. */
  private modelCredential(): Outcome {
    const runtimes = runtimesInUse(this.config.env);
    return worst(
      runtimes.map((runtime) => this.runtimeCredential(runtime)),
      runtimes.join(' · '),
    );
  }

  private runtimeCredential(runtime: RuntimeName): Outcome {
    try {
      const { name } = credentialFor(this.config.env, runtime);
      return ok(`${name} is set for ${runtime}`, runtime);
    } catch (error) {
      return missingModelCredential(runtime, error instanceof Error ? error.message : String(error));
    }
  }

  private async codeHostToken(): Promise<Outcome> {
    const named = this.hosts.names.filter((name) => this.hosts.credentials(name).token.trim() !== '');
    if (named.length === 0 && (await this.connections?.anyConnected())) {
      return ok('a person is connected to a code host', 'connected');
    }
    if (named.length === 0) {
      return {
        status: 'warn',
        line: 'no code host token is set',
        short: 'not set',
        action: `Connect ${codeHostAdapters()
          .map((adapter) => adapter.label)
          .join(' or ')} in Connections to publish`,
        link: '/connections',
      };
    }
    return worst(await Promise.all(named.map((name) => this.hostToken(name))), named.join(' · '));
  }

  /** One free, read-only call: who the token belongs to. */
  private async hostToken(name: (typeof this.hosts.names)[number]): Promise<Outcome> {
    const key = this.hosts.credentials(name).tokenKey;
    try {
      const host = (await this.hosts.forRun(null)).byName(name);
      await withinWait(host.readCurrentUser(), HOST_WAIT_MS);
    } catch (error) {
      const calls = error instanceof FetchFailed ? error.httpCalls : [];
      if (calls.some((call) => call.statusCode === 401 || call.statusCode === 403)) {
        return {
          status: 'fail',
          line: `${key} was rejected`,
          short: name,
          action: `replace ${key} with a valid token`,
        };
      }
      return {
        status: 'warn',
        line: `${key} could not be checked`,
        short: name,
        action: 'check the network and the base URL',
      };
    }
    return ok(`${key} is accepted`, name);
  }
}

/** The answer, or a rejection when it takes longer than `ms`; the late answer is dropped. */
function withinWait<T>(answer: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no answer in time')), ms);
    answer.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
