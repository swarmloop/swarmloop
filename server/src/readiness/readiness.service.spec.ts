import 'reflect-metadata';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppConfig, type SwarmloopEnv } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import type { ReadinessId, ReadinessItem } from '../contract/readiness';
import { instantBackoff } from '../integrations/instant-backoff.spec-helpers';
import { CodeHostRegistry } from '../integrations/code-host/code-host.registry';
import { DiskGuard } from '../pipeline/disk-guard';
import { OwnUseMeter } from '../pipeline/own-use-meter';
import { imageName } from '../sandbox/image-resolver';
import { SandboxService } from '../sandbox/sandbox.service';
import { ReadinessService } from './readiness.service';

const GB = 1024 ** 3;

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
  function setup(env: Partial<SwarmloopEnv> = {}, free = 50 * GB): ReadinessService {
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
    return new ReadinessService(config, sandbox, disk, CodeHostRegistry.create(config.env, clock), clock, meter);
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
    const measure = jest.spyOn(meter, 'measure');
    const first = await service.report();
    clock.advance(10 * 60_000);
    const fresh = await service.fresh();
    expect(measure).toHaveBeenCalledTimes(1);
    expect(fresh.checkedAt).not.toBe(first.checkedAt);
    expect((await service.report()).checkedAt).toBe(first.checkedAt);
  });

  it('carries the time of the report and the load of the sandbox snapshot', async () => {
    const service = setup();
    const load = {
      capacityMemoryBytes: 8 * GB,
      usedMemoryBytes: GB,
      running: ['a'],
      waiting: [],
    };
    jest.spyOn(sandbox, 'snapshot').mockReturnValue(load);
    expect(await service.report()).toMatchObject({ checkedAt: clock.iso(), load });
  });

  it('keeps the last report while a stale one refreshes, one refresh at a time', async () => {
    const service = setup();
    const first = await service.report();
    clock.advance(30_000);
    expect(await service.report()).toBe(first);
    expect(docker).toHaveBeenCalled();

    const release: (() => void)[] = [];
    docker.mockReset();
    docker.mockImplementation(() => new Promise<string>((done) => release.push(() => done(''))));
    clock.advance(31_000);
    const [a, b] = await Promise.all([service.report(), service.report()]);
    expect(a).toBe(first);
    expect(b).toBe(first);
    const infoCalls = (): number => docker.mock.calls.filter(([args]) => (args as string[])[0] === 'info').length;
    expect(infoCalls()).toBe(1);

    const built = new Promise<void>((done) => {
      const load = sandbox.snapshot();
      jest.spyOn(sandbox, 'snapshot').mockImplementation(() => {
        done();
        return load;
      });
    });
    release.splice(0).forEach((done) => done());
    await built;
    await new Promise((flushed) => setImmediate(flushed));
    expect(infoCalls()).toBe(1);
    expect((await service.report()).checkedAt).toBe(clock.iso());
  });

  it('answers within a second with no items when a check hangs', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      const service = setup();
      const releases: (() => void)[] = [];
      docker.mockImplementation(() => new Promise<string>((done) => releases.push(() => done(''))));
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
    expect(missing).toMatchObject({ status: 'fail', action: expect.stringContaining('ANTHROPIC_API_KEY') });
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
      action: expect.stringContaining('ANTHROPIC_API_KEY'),
    });
    const set = await itemOf(setup({ AGENTS_SUBTASK_REVIEW: 'claude:m', ANTHROPIC_API_KEY: 'k' }), 'model-credential');
    expect(set).toMatchObject({
      status: 'ok',
      line: 'CURSOR_API_KEY is set for cursor; ANTHROPIC_API_KEY is set for claude',
    });
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
        action: 'Connect GitHub or GitLab to publish, or set GITHUB_TOKEN or GITLAB_TOKEN',
      });
      expect(remote()).toEqual([]);
    });

    it('is ok when the host accepts the token, with one GET and nothing else', async () => {
      const service = setup(github);
      answering(200);
      expect((await itemOf(service, 'code-host-token')).status).toBe('ok');
      expect(remote()).toEqual([{ method: 'GET', url: 'https://api.github.com/user' }]);
    });

    it('fails when the host rejects the token', async () => {
      const service = setup(github);
      answering(401);
      expect(await itemOf(service, 'code-host-token')).toMatchObject({
        status: 'fail',
        line: 'GITHUB_TOKEN was rejected',
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
