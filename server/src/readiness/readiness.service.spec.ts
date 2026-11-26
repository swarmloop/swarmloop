import 'reflect-metadata';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppConfig, type SwarmloopEnv } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import type { ReadinessId, ReadinessItem } from '../contract/readiness';
import { instantBackoff } from '../integrations/instant-backoff.spec-helpers';
import { runtimeFor } from '../integrations/agent-runtime/agent-runtime.registry';
import { CodeHostRegistry } from '../integrations/code-host/code-host.registry';
import { DiskGuard } from '../pipeline/disk-guard';
import { OwnUseMeter } from '../pipeline/own-use-meter';
import { imageName } from '../sandbox/image-resolver';
import { SandboxService } from '../sandbox/sandbox.service';
import { PersonalCredentials } from '../auth/personal-credentials.service';
import { SecretBox } from '../auth/secret-box';
import { IntegrationSecretRepository } from '../history/integration-secret.repository';
import { repositoryDatabase } from '../history/repository.spec-helpers';
import { UserSettingRepository } from '../history/user-setting.repository';
import { fakeConnection } from '../testing/fake-connection';
import { ReadinessModelCredential } from './readiness-model-credential';
import type { ConnectionsService } from '../auth/connections.service';
import { ReadinessPaths } from './readiness-paths';
import { ReadinessStalls } from './readiness-stalls';
import { ReadinessService } from './readiness.service';

const GB = 1024 ** 3;

interface StallRow {
  startedAt: string;
  durationMs: number;
  kind: 'server-blocked' | 'host-paused';
}

describe('ReadinessService', () => {
  const original = global.fetch;
  const dirs: string[] = [];
  const servers: Server[] = [];
  let docker: jest.Mock;
  let freePort = 0;
  let fetched: { method: string; url: string }[];
  let clock: FakeClock;
  let meter: OwnUseMeter;
  let sandbox: SandboxService;
  let config: AppConfig;

  /** A port nothing listens on: one that was just given back. */
  beforeAll(async () => {
    const server = createServer();
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    freePort = (server.address() as AddressInfo).port;
    await new Promise((done) => server.close(done));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    global.fetch = original;
    for (const dir of dirs.splice(0)) {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
    await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  });

  /** A server whose `data/` and `worktrees/` live in a temp directory, with every check green unless a case changes it. */
  function setup(
    env: Partial<SwarmloopEnv> = {},
    free = 50 * GB,
    person?: (config: AppConfig) => ReadinessModelCredential,
    stallRows: StallRow[] = [],
    connections?: ConnectionsService,
  ): ReadinessService {
    const home = mkdtempSync(join(tmpdir(), 'readiness-'));
    dirs.push(home);
    mkdirSync(join(home, 'data'));
    mkdirSync(join(home, 'worktrees'));
    config = new AppConfig(
      testEnv({ SWARMLOOP_ROOT: home, SWARMLOOP_API_PORT: freePort, CURSOR_API_KEY: 'key', ...env }),
    );
    docker = jest.fn(async () => '');
    sandbox = new SandboxService();
    sandbox.useDocker(docker);
    const disk = new DiskGuard(config, {} as never, sandbox);
    disk.useFreeBytes(async () => free);
    fetched = [];
    global.fetch = jest.fn(async (url: string, init?: { method?: string }) => {
      fetched.push({ method: init?.method ?? 'GET', url: String(url) });
      if (String(url).startsWith('http://127.0.0.1')) {
        return original(url, init);
      }
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    clock = new FakeClock();
    meter = new OwnUseMeter(config, clock);
    const hosts = CodeHostRegistry.create(config.env, clock);
    const stalls = new ReadinessStalls(
      { since: async (iso: string) => stallRows.filter((row) => row.startedAt >= iso) } as never,
      clock,
    );
    const folders = new ReadinessPaths(config, sandbox);
    return new ReadinessService(
      config,
      sandbox,
      disk,
      hosts,
      clock,
      meter,
      folders,
      connections,
      person?.(config),
      stalls,
    );
  }

  /** The calls that left for a code host. The port probes stay on this machine. */
  function remote(): typeof fetched {
    return fetched.filter((call) => !call.url.startsWith('http://127.0.0.1'));
  }

  async function itemOf(service: ReadinessService, id: ReadinessId): Promise<ReadinessItem> {
    const found = (await service.fresh()).items.find((item) => item.id === id);
    if (!found) {
      throw new Error(`no ${id} item`);
    }
    return found;
  }

  async function listener(handler: (url: string) => string): Promise<number> {
    const server = createServer((request, response) => response.end(handler(request.url ?? '')));
    servers.push(server);
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    return (server.address() as AddressInfo).port;
  }

  it('is ok everywhere when a run can start, and only credentials are warned about without a token', async () => {
    const { items } = await setup().report();
    expect(items.map((item) => item.id)).toEqual([
      'docker',
      'arch',
      'images',
      'disk',
      'paths',
      'ports',
      'model-credential',
      'code-host-token',
    ]);
    expect(items.filter((item) => item.status !== 'ok').map((item) => item.id)).toEqual(['code-host-token']);
    for (const item of items) {
      expect(item.line).not.toContain('\n');
      expect(item.action).not.toBe('');
    }
  });

  it("shows Docker's CPUs and memory once docker has answered with them", async () => {
    const service = setup();
    docker.mockImplementation(async (args: string[]) => (args.includes('--format') ? '8 16750372454\n' : ''));
    expect((await itemOf(service, 'docker')).line).toBe(
      '8 CPUs · 15.6 GB · 2 checks × 4 cores (CHECKS_PARALLEL 3; 2 fit with 4 cores each)',
    );
  });

  it('names the checks and their cores in the docker line', async () => {
    const service = setup({ CHECKS_PARALLEL: 3 });
    docker.mockImplementation(async (args: string[]) => (args.includes('--format') ? '8 25125558681\n' : ''));
    expect((await itemOf(service, 'docker')).line).toBe(
      '8 CPUs · 23.4 GB · 2 checks × 4 cores (CHECKS_PARALLEL 3; 2 fit with 4 cores each)',
    );
    const two = setup({ CHECKS_PARALLEL: 2 });
    docker.mockImplementation(async (args: string[]) => (args.includes('--format') ? '8 25125558681\n' : ''));
    expect((await itemOf(two, 'docker')).line).toBe('8 CPUs · 23.4 GB · 2 checks × 4 cores');
    const small = setup({ CHECKS_PARALLEL: 3 });
    docker.mockImplementation(async (args: string[]) => (args.includes('--format') ? '2 25125558681\n' : ''));
    expect((await itemOf(small, 'docker')).line).toMatch(
      /· 1 check × 2 cores \(CHECKS_PARALLEL 3; 1 fits with 4 cores each\)$/,
    );
  });

  it('cuts a short of every item, and the model key joins its runtimes', async () => {
    const service = setup({ AGENTS_SUBTASK_REVIEW: 'claude:m', ANTHROPIC_API_KEY: 'k' });
    const { items } = await service.report();
    const shorts = Object.fromEntries(items.map((item) => [item.id, item.short]));
    expect(shorts).toMatchObject({
      docker: 'running',
      arch: process.arch,
      disk: '50.0 GB free',
      paths: 'writable',
      ports: expect.stringMatching(/^\d+ · 3921$/),
      'model-credential': 'cursor · claude',
      'code-host-token': 'not set',
    });
    expect(shorts.images).toMatch(/^\d+ present$/);
  });

  it('cuts the docker short without the CHECKS_PARALLEL note, and says not running when docker is down', async () => {
    const service = setup({ CHECKS_PARALLEL: 3 });
    docker.mockImplementation(async (args: string[]) => (args.includes('--format') ? '8 25125558681\n' : ''));
    expect((await itemOf(service, 'docker')).short).toBe('8 CPUs · 23.4 GB · 2 checks × 4 cores');
    const down = setup();
    docker.mockRejectedValue(new Error('no docker'));
    expect((await itemOf(down, 'docker')).short).toBe('not running');
  });

  it('gives the disk item its own use with the age of the measure, and says when it was not measured', async () => {
    const service = setup();
    expect((await service.report()).items.find((item) => item.id === 'disk')?.ownUse).toBe('sizes not measured yet');
    await meter.measure();
    clock.advance(4 * 60_000 + 5000);
    jest.spyOn(meter, 'measure').mockResolvedValue();
    const disk = await itemOf(service, 'disk');
    expect(disk.ownUse).toBe('worktrees 0 B, logs 0 B, backups 0 B, environment cache 0 B, measured 4 min ago');
    expect(disk.line).toContain('; swarmloop uses worktrees 0 B');
    expect((await itemOf(service, 'docker')).ownUse).toBeUndefined();
  });

  it('says only that docker answers when no reading is kept', async () => {
    expect((await itemOf(setup(), 'docker')).line).toBe('docker answers');
  });

  it('warns of the stalls of the last hour, most frequent kind first', async () => {
    const service = setup({}, 50 * GB, undefined, [
      { startedAt: '2025-12-31T22:00:00.000Z', durationMs: 99_000, kind: 'host-paused' },
      { startedAt: '2025-12-31T23:30:00.000Z', durationMs: 20_000, kind: 'server-blocked' },
      { startedAt: '2025-12-31T23:45:00.000Z', durationMs: 12_000, kind: 'server-blocked' },
    ]);
    expect(await itemOf(service, 'stalls')).toMatchObject({
      status: 'warn',
      line: 'The server stalled 2 times in the last hour, 32 s in all (server blocked)',
      short: '2 times in the last hour',
      link: '/stats#statistics',
    });
  });

  it('says 1 time for a single stall', async () => {
    const service = setup({}, 50 * GB, undefined, [
      { startedAt: '2025-12-31T23:30:00.000Z', durationMs: 20_000, kind: 'host-paused' },
    ]);
    expect((await itemOf(service, 'stalls')).line).toBe(
      'The server stalled 1 time in the last hour, 20 s in all (machine paused)',
    );
  });

  it('has no stalls item without stalls in the last hour', async () => {
    const service = setup({}, 50 * GB, undefined, [
      { startedAt: '2025-12-31T22:00:00.000Z', durationMs: 20_000, kind: 'host-paused' },
    ]);
    expect((await service.fresh()).items.map((item) => item.id)).not.toContain('stalls');
  });

  it('does not start a version probe when Docker info fails', async () => {
    const service = setup();
    let versionStarted = false;
    docker.mockImplementation(async (args: string[]) => {
      if (args[0] === 'info') throw new Error('Docker unavailable');
      if (args[0] === 'version') versionStarted = true;
      return '';
    });
    expect(await itemOf(service, 'docker')).toMatchObject({ status: 'fail', line: 'docker is not running' });
    expect(versionStarted).toBe(false);
  });

  it('fails when the Docker Engine is older than 26 and passes with 26', async () => {
    const service = setup();
    docker.mockImplementation(async (args: string[]) => (args[0] === 'version' ? '25.0.3\n' : ''));
    const old = await itemOf(service, 'docker');
    expect(old.status).toBe('fail');
    expect(old.line).toContain('25.0.3');
    expect(old.line).toContain('Engine 26');
    expect(old.action).toBe('update Docker to Engine 26 or newer');
    expect(old.short).toBe('too old');
    docker.mockImplementation(async (args: string[]) => (args[0] === 'version' ? '26.1.4\n' : ''));
    expect((await itemOf(service, 'docker')).status).toBe('ok');
    docker.mockImplementation(async (args: string[]) => (args[0] === 'version' ? 'n/a' : ''));
    expect(await itemOf(service, 'docker')).toMatchObject({ status: 'ok', line: 'docker answers' });
  });

  it('names the volumes the server keeps its worktrees and checkouts in', async () => {
    const checkouts = join(realpathSync(tmpdir()), 'readiness-checkouts');
    const service = setup({ CHECKOUTS_ROOT: checkouts });
    const worktrees = join(realpathSync(dirs[0]), 'worktrees');
    const mounts = [
      { Type: 'volume', Name: 'swarmloop-worktrees', Destination: worktrees },
      { Type: 'volume', Name: 'swarmloop-checkouts', Destination: checkouts },
    ];
    docker.mockImplementation(async (args: string[]) => (args[0] === 'inspect' ? JSON.stringify(mounts) : ''));
    const item = await itemOf(service, 'paths');
    expect(item.status).toBe('ok');
    expect(item.line).toContain(`${worktrees} is volume swarmloop-worktrees for the daemon`);
    expect(item.line).toContain(`${checkouts} is volume swarmloop-checkouts for the daemon`);
  });

  it('fails when docker is down', async () => {
    const service = setup();
    docker.mockRejectedValue(new Error('Cannot connect to the Docker daemon'));
    const item = await itemOf(service, 'docker');
    expect(item.status).toBe('fail');
    expect(item.action).toBe('start Docker or mount the Docker socket');
  });

  it('fails when an image is missing and says compose pulls it', async () => {
    const service = setup();
    docker.mockRejectedValue(new Error('No such image'));
    const item = await itemOf(service, 'images');
    expect(item).toMatchObject({ status: 'fail', action: expect.stringContaining('docker compose up -d') });
    expect(item.line).toContain(imageName('agent-cursor'));
    expect(item.line).toContain(imageName('egress'));
    expect(item.short).toMatch(/^\d+ missing$/);
  });

  it('says check failed for a check that throws, in the build and in the stalls item', async () => {
    const service = setup();
    jest.spyOn(sandbox, 'daemonPlace').mockRejectedValue(new Error('daemon gone'));
    jest.spyOn(ReadinessStalls.prototype, 'outcome').mockRejectedValue(new Error('no stall table'));
    const { items } = await service.fresh();
    expect(items.find((item) => item.id === 'paths')).toMatchObject({
      status: 'fail',
      line: 'daemon gone',
      short: 'check failed',
    });
    expect(items.find((item) => item.id === 'stalls')).toMatchObject({
      status: 'warn',
      line: 'no stall table',
      short: 'check failed',
    });
  });

  it('fails below MIN_FREE_GB, warns under one and a half times it, and says the free GB', async () => {
    const low = await itemOf(setup({ MIN_FREE_GB: 10 }, 4 * GB), 'disk');
    expect(low.status).toBe('fail');
    expect(low.line).toContain('4.0 GB free');
    expect((await itemOf(setup({ MIN_FREE_GB: 10 }, 12 * GB), 'disk')).status).toBe('warn');
    expect((await itemOf(setup({ MIN_FREE_GB: 10 }, 15 * GB), 'disk')).status).toBe('ok');
  });

  it('lists what swarmloop itself uses after the free space, with a size each', async () => {
    const service = setup();
    const home = dirs[0];
    mkdirSync(join(home, 'worktrees', 'run-1'));
    writeFileSync(join(home, 'worktrees', 'run-1', 'file'), Buffer.alloc(2048));
    writeFileSync(join(home, 'data', 'run-1-implement-output.txt'), Buffer.alloc(1024));
    mkdirSync(join(home, 'data', 'backups'));
    writeFileSync(join(home, 'data', 'backups', 'swarmloop-x.sqlite.gz'), Buffer.alloc(3 * 1024 * 1024));
    const { line } = await itemOf(service, 'disk');
    expect(line).toMatch(/^50\.0 GB free, a step needs \d+ GB \(MIN_FREE_GB\); swarmloop uses /);
    expect(line).toContain('worktrees 2.0 KB, logs 1.0 KB, backups 3.0 MB, environment cache 0 B');
  });

  it('says the sizes are not measured yet, and that it measured 4 min ago once it did', async () => {
    const service = setup();
    expect((await service.report()).items.find((item) => item.id === 'disk')?.line).toContain(
      '; sizes not measured yet',
    );
    await meter.measure();
    clock.advance(4 * 60_000 + 5000);
    jest.spyOn(meter, 'measure').mockResolvedValue();
    expect((await service.fresh()).items.find((item) => item.id === 'disk')?.line).toMatch(
      /environment cache 0 B, measured 4 min ago$/,
    );
  });

  it('answers a report from the last measure without walking the folders', async () => {
    const service = setup();
    const measure = jest.spyOn(meter, 'measure');
    await service.report();
    clock.advance(10 * 60_000);
    await service.report();
    expect(measure).not.toHaveBeenCalled();
  });

  it('measures once for a fresh report and keeps the cached one', async () => {
    const service = setup();
    const measured: string[] = [];
    const measure = meter.measure.bind(meter);
    jest.spyOn(meter, 'measure').mockImplementation((...args) => {
      measured.push('measure');
      return measure(...args);
    });
    const first = await service.report();
    clock.advance(10 * 60_000);
    const fresh = await service.fresh();
    expect(measured).toEqual(['measure']);
    expect(fresh.checkedAt).not.toBe(first.checkedAt);
    expect((await service.report()).checkedAt).toBe(first.checkedAt);
  });

  it('keeps the last report while a stale one refreshes, one refresh at a time', async () => {
    const service = setup();
    const first = await service.report();
    clock.advance(30_000);
    expect(await service.report()).toBe(first);
    expect(docker).toHaveBeenCalled();

    const release: (() => void)[] = [];
    docker.mockReset();
    docker.mockImplementation((args: string[]) =>
      args[0] === 'info' ? new Promise<string>((done) => release.push(() => done(''))) : Promise.resolve(''),
    );
    clock.advance(31_000);
    const [a, b] = await Promise.all([service.report(), service.report()]);
    expect(a).toBe(first);
    expect(b).toBe(first);
    const infoCalls = (): number => docker.mock.calls.filter(([args]) => (args as string[])[0] === 'info').length;
    expect(infoCalls()).toBe(1);

    // The refresh ends with the time it stamps the report with, after its real file and socket checks: wait for that, not for a number of turns.
    const stamped = new Promise<void>((done) => {
      const iso = clock.iso.bind(clock);
      jest.spyOn(clock, 'iso').mockImplementation(() => {
        done();
        return iso();
      });
    });
    release.splice(0).forEach((done) => done());
    await stamped;
    await new Promise((flushed) => setImmediate(flushed));
    expect(infoCalls()).toBe(1);
    expect((await service.report()).checkedAt).toBe(clock.iso());
  });

  it('answers within a second with no items when a check hangs', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      const service = setup();
      const releases: (() => void)[] = [];
      docker.mockImplementation((args: string[]) =>
        args[0] === 'info' ? new Promise<string>((done) => releases.push(() => done(''))) : Promise.resolve(''),
      );
      const answer = service.report();
      await jest.advanceTimersByTimeAsync(1000);
      expect(await answer).toMatchObject({ items: [], checkedAt: null });
      releases.forEach((release) => release());
    } finally {
      jest.useRealTimers();
    }
  });

  it('fails for a directory the server cannot write and names chown', async () => {
    const service = setup();
    const home = dirs[0];
    chmodSync(join(home, 'data'), 0o500);
    const item = await itemOf(service, 'paths');
    expect(item.status).toBe('fail');
    expect(item.line).toContain(join(home, 'data'));
    expect(item.action).toContain('chown');
    expect(item.short).toBe('not writable');
    chmodSync(join(home, 'data'), 0o700);
  });

  it('fails when another process answers on the API port, and accepts our own /health', async () => {
    const foreign = await listener(() => 'hello');
    const taken = await itemOf(setup({ SWARMLOOP_API_PORT: foreign }), 'ports');
    expect(taken.status).toBe('fail');
    expect(taken.action).toBe('stop the other process or change the port');

    const ours = await listener((url) => (url === '/health' ? '{"status":"ok"}' : ''));
    const own = setup({ SWARMLOOP_API_PORT: ours });
    expect((await itemOf(own, 'ports')).status).toBe('ok');
  });

  it('fails when the runtime has no model credential, and passes with one', async () => {
    const missing = await itemOf(
      setup({ AGENTS_PLAN: 'claude:m', AGENTS_IMPLEMENT: 'claude:m', AGENTS_REVIEW: 'claude:m' }),
      'model-credential',
    );
    expect(missing).toMatchObject({ status: 'fail', action: 'connect claude in Connections' });
    expect(
      (
        await itemOf(
          setup({
            AGENTS_PLAN: 'claude:m',
            AGENTS_IMPLEMENT: 'claude:m',
            AGENTS_REVIEW: 'claude:m',
            CLAUDE_CODE_OAUTH_TOKEN: 't',
          }),
          'model-credential',
        )
      ).status,
    ).toBe('ok');
    expect((await itemOf(setup({ CURSOR_API_KEY: '' }), 'model-credential')).status).toBe('fail');
  });

  it('checks the credential of every runtime a role names, one line each', async () => {
    expect(await itemOf(setup(), 'model-credential')).toMatchObject({
      status: 'ok',
      line: 'CURSOR_API_KEY is set for cursor',
    });
    const missing = await itemOf(setup({ AGENTS_REVIEW: 'claude:m' }), 'model-credential');
    expect(missing).toMatchObject({
      status: 'fail',
      line: expect.stringContaining(
        'CURSOR_API_KEY is set for cursor; ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN is missing',
      ),
      action: 'connect claude in Connections',
    });
    const set = await itemOf(setup({ AGENTS_SUBTASK_REVIEW: 'claude:m', ANTHROPIC_API_KEY: 'k' }), 'model-credential');
    expect(set).toMatchObject({
      status: 'ok',
      line: 'CURSOR_API_KEY is set for cursor; ANTHROPIC_API_KEY is set for claude',
    });
  });

  describe('model credential of a person', () => {
    const CLAUDE = {
      AGENTS_PLAN: 'claude:m',
      AGENTS_IMPLEMENT: 'claude:m',
      AGENTS_REVIEW: 'claude:m',
      CURSOR_API_KEY: '',
    };

    /** A service whose person view reads a real store on the same config as the service. */
    async function withPerson(
      env: Partial<SwarmloopEnv>,
      body: (service: ReadinessService, store: PersonalCredentials, settings: UserSettingRepository) => Promise<void>,
    ): Promise<void> {
      const db = await repositoryDatabase();
      try {
        let store!: PersonalCredentials;
        const settings = db.app.get(UserSettingRepository);
        const service = setup(env, 50 * GB, (own) => {
          store = new PersonalCredentials(db.app.get(IntegrationSecretRepository), new SecretBox('k'), clock, own);
          return new ReadinessModelCredential(own, store, settings);
        });
        await body(service, store, settings);
      } finally {
        await db.close();
      }
    }

    const credentialOf = async (service: ReadinessService, login: string | null) =>
      (await service.report(login)).items.find((item) => item.id === 'model-credential');

    it('links a missing runtime to its card', async () => {
      expect(await itemOf(setup(CLAUDE), 'model-credential')).toMatchObject({
        status: 'fail',
        link: '/connections#claude',
      });
    });

    it('is ok with nothing to do when the person connected the runtime', () =>
      withPerson(CLAUDE, async (service, store) => {
        const claude = fakeConnection({ id: 'claude', fields: ['ANTHROPIC_API_KEY'] });
        await store.store(claude, 'alice', { ANTHROPIC_API_KEY: 'sk-ant-alice-1234' }, null);
        expect(await credentialOf(service, 'alice')).toMatchObject({ status: 'ok', action: 'nothing to do' });
      }));

    describe('when the agents name a level and the model list of their runtime is not loaded', () => {
      const LEVELS = {
        AGENTS_PLAN: 'cursor:grok-4.7:high',
        AGENTS_IMPLEMENT: 'cursor:grok-4.7:high',
        AGENTS_REVIEW: 'cursor:grok-4.7:high',
        CURSOR_API_KEY: '',
      };

      it('names the missing runtime and links its card, for a person and for the server', () =>
        withPerson(LEVELS, async (service) => {
          expect(runtimeFor('cursor').listLoaded()).toBe(false);
          expect(await credentialOf(service, 'alice')).toMatchObject({
            status: 'fail',
            line: expect.stringContaining('cursor has no credential for you'),
            link: '/connections#cursor',
          });
          expect(await credentialOf(service, null)).toMatchObject({
            status: 'fail',
            line: 'CURSOR_API_KEY is missing',
            link: '/connections#cursor',
          });
        }));

      it('is ok once the person connected the runtime', () =>
        withPerson(LEVELS, async (service, store) => {
          const cursor = fakeConnection({ id: 'cursor', fields: ['CURSOR_API_KEY'] });
          await store.store(cursor, 'alice', { CURSOR_API_KEY: 'crsr-alice-1234' }, null);
          expect(await credentialOf(service, 'alice')).toMatchObject({ status: 'ok' });
        }));
    });

    it('tells a person with no connection which runtime is missing, and keeps env views env-only', () =>
      withPerson(CLAUDE, async (service, store) => {
        const claude = fakeConnection({ id: 'claude', fields: ['ANTHROPIC_API_KEY'] });
        await store.store(claude, 'alice', { ANTHROPIC_API_KEY: 'sk-ant-alice-1234' }, null);
        expect(await credentialOf(service, 'bob')).toMatchObject({
          status: 'fail',
          line: expect.stringContaining('claude has no credential for you'),
          link: '/connections#claude',
        });
        expect(await credentialOf(service, 'machine')).toMatchObject({ status: 'fail' });
        expect(await credentialOf(service, null)).toMatchObject({ status: 'fail' });
        expect((await itemOf(service, 'model-credential')).status).toBe('fail');
      }));

    it("checks the runtimes of the person's saved agents, else the env lists", () =>
      withPerson({ ...CLAUDE, CURSOR_API_KEY: 'key' }, async (service, _store, settings) => {
        expect(await credentialOf(service, 'carol')).toMatchObject({ status: 'fail' });
        await settings.save('carol', { agents: { main: { plan: [{ runtime: 'cursor', model: 'm' }] } } });
        expect(await credentialOf(service, 'carol')).toMatchObject({ status: 'fail' });
        const all = { plan: [{ runtime: 'cursor', model: 'm' }], implement: [{ runtime: 'cursor', model: 'm' }] };
        await settings.save('dana', {
          agents: {
            main: { ...all, review: [{ runtime: 'cursor', model: 'm' }] },
            subtask: { ...all, review: [{ runtime: 'cursor', model: 'm' }] },
          },
        });
        expect(await credentialOf(service, 'dana')).toMatchObject({
          status: 'ok',
          line: 'CURSOR_API_KEY is set for cursor',
          short: 'cursor',
        });
      }));
  });

  describe('code host token', () => {
    function answering(status: number): void {
      global.fetch = jest.fn(async (url: string, init?: { method?: string }) => {
        fetched.push({ method: init?.method ?? 'GET', url: String(url) });
        return {
          status,
          ok: status < 300,
          url: String(url),
          headers: { get: () => 'application/json' },
          arrayBuffer: async () => Buffer.from('{}'),
        };
      }) as unknown as typeof fetch;
    }

    const github = { GITHUB_BASE_URL: 'https://github.com', GITHUB_TOKEN: 'ghp' };

    it('warns when no token is set, without calling a host', async () => {
      const item = await itemOf(setup(), 'code-host-token');
      expect(item).toMatchObject({
        status: 'warn',
        action: 'Connect GitHub or GitLab in Connections to publish',
        link: '/connections',
        short: 'not set',
      });
      expect(remote()).toEqual([]);
    });

    it('says a person is connected when no token is set but someone connected', async () => {
      const connected = { anyConnected: async () => true } as ConnectionsService;
      const service = setup({}, 50 * GB, undefined, [], connected);
      expect(await itemOf(service, 'code-host-token')).toMatchObject({ status: 'ok', short: 'connected' });
    });

    it('is ok when the host accepts the token, with one GET and nothing else', async () => {
      const service = setup(github);
      answering(200);
      expect(await itemOf(service, 'code-host-token')).toMatchObject({ status: 'ok', short: 'github' });
      expect(remote()).toEqual([{ method: 'GET', url: 'https://api.github.com/user' }]);
    });

    it('fails when the host rejects the token', async () => {
      const service = setup(github);
      answering(401);
      expect(await itemOf(service, 'code-host-token')).toMatchObject({
        status: 'fail',
        line: 'GITHUB_TOKEN was rejected',
        short: 'github',
      });
    });

    it('warns when the host cannot be reached', async () => {
      instantBackoff();
      const service = setup(github);
      global.fetch = jest.fn(async () => {
        throw new TypeError('fetch failed');
      });
      expect((await itemOf(service, 'code-host-token')).status).toBe('warn');
    });
  });

  it('reports an unreachable host within a bounded wait while its calls are retried', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      const service = setup({ GITHUB_TOKEN: 'ghp', GITHUB_BASE_URL: 'https://github.com' });
      global.fetch = jest.fn(async () => {
        throw new TypeError('fetch failed');
      });
      jest.spyOn(meter, 'measure').mockResolvedValue();
      const item = itemOf(service, 'code-host-token');
      await jest.advanceTimersByTimeAsync(5000);
      expect(await item).toMatchObject({ status: 'warn', line: 'GITHUB_TOKEN could not be checked' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('never pulls an image and sends no write across a full report', async () => {
    instantBackoff();
    const service = setup({ GITHUB_TOKEN: 'ghp', GITHUB_BASE_URL: 'https://github.com' });
    await service.report();
    expect(docker.mock.calls.flatMap(([args]) => args as string[])).not.toContain('pull');
    expect(fetched.every((call) => call.method === 'GET')).toBe(true);
  });
});
