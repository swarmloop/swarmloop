import 'reflect-metadata';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppConfig, type SwarmloopEnv } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import type { ReadinessId, ReadinessItem } from '../contract/api';
import { CodeHostRegistry } from '../integrations/code-host/code-host.registry';
import { DiskGuard } from '../pipeline/disk-guard';
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

  /** A port nothing listens on: one that was just given back. */
  beforeAll(async () => {
    const server = createServer();
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    freePort = (server.address() as AddressInfo).port;
    await new Promise((done) => server.close(done));
  });

  afterEach(async () => {
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
    const config = new AppConfig(
      testEnv({ SWARMLOOP_ROOT: home, SWARMLOOP_API_PORT: freePort, CURSOR_API_KEY: 'key', ...env }),
    );
    docker = jest.fn(async () => '');
    const sandbox = new SandboxService();
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
    return new ReadinessService(config, sandbox, disk, CodeHostRegistry.create(config.env, new FakeClock()));
  }

  /** The calls that left for a code host. The port probes stay on this machine. */
  function remote(): typeof fetched {
    return fetched.filter((call) => !call.url.startsWith('http://127.0.0.1'));
  }

  async function itemOf(service: ReadinessService, id: ReadinessId): Promise<ReadinessItem> {
    const found = (await service.report()).items.find((item) => item.id === id);
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
    const missing = await itemOf(setup({ RUNTIME: 'claude' }), 'model-credential');
    expect(missing).toMatchObject({ status: 'fail', action: expect.stringContaining('ANTHROPIC_API_KEY') });
    expect((await itemOf(setup({ RUNTIME: 'claude', CLAUDE_CODE_OAUTH_TOKEN: 't' }), 'model-credential')).status).toBe(
      'ok',
    );
    expect((await itemOf(setup({ CURSOR_API_KEY: '' }), 'model-credential')).status).toBe('fail');
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
      expect(item).toMatchObject({ status: 'warn', action: 'set GITHUB_TOKEN or GITLAB_TOKEN to publish' });
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
      const service = setup(github);
      global.fetch = jest.fn(async () => {
        throw new TypeError('fetch failed');
      });
      expect((await itemOf(service, 'code-host-token')).status).toBe('warn');
    });
  });

  it('never pulls an image and sends no write across a full report', async () => {
    const service = setup({ GITHUB_TOKEN: 'ghp', GITHUB_BASE_URL: 'https://github.com' });
    await service.report();
    expect(docker.mock.calls.flatMap(([args]) => args as string[])).not.toContain('pull');
    expect(fetched.every((call) => call.method === 'GET')).toBe(true);
  });
});
