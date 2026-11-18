import { EventEmitter } from 'events';
import { mkdirSync, mkdtempSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppConfig } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import { ContainerDropped, ContainerGate } from './container-gate';
import { SandboxService } from './sandbox.service';
import type { SandboxChild } from './sandbox.service';
import type { SandboxLaunch } from './sandbox-types';

const GB = 1024 ** 3;

type Given = Omit<SandboxLaunch, 'maskFile' | 'envMasks' | 'workRoots'>;

const projectLaunch = {
  image: 'swarmloop-env-demo:0123456789ab',
  cliVolume: 'swarmloop-cli-claude-0123456789ab',
  path: '/usr/local/bin:/usr/bin:/bin',
  certFile: true,
  caches: [],
  shell: 'npm test',
};

describe('SandboxService memory cap', () => {
  const saved = { ...process.env };
  let root: string;
  let children: SandboxChild[];
  let runs: string[][];

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'swarmloop-cap-')));
    mkdirSync(join(root, 'worktrees', 'k', 'demo'), { recursive: true });
    process.env.SWARMLOOP_ROOT = root;
    process.env.SANDBOX_EGRESS = 'open';
    children = [];
    runs = [];
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  /** 3 GB with a reserve of 1 GB: small enough that a queue would hold work back. */
  function service(
    info: (args: string[]) => Promise<string> | string = () => `4 ${3 * GB}`,
    spawnFails = false,
  ): SandboxService {
    const sandbox = new SandboxService(new AppConfig(testEnv({ RESERVE_MEMORY_GB: 1 })));
    sandbox.useDocker(async (args) => {
      if (args[0] === 'info') {
        return info(args);
      }
      return '';
    });
    sandbox.spawnDocker = (args) => {
      runs.push(args);
      if (spawnFails) {
        throw new Error('docker run failed');
      }
      const child = new EventEmitter() as SandboxChild;
      child.containerName = args[args.indexOf('--name') + 1] ?? '';
      children.push(child);
      return child;
    };
    return sandbox;
  }

  function launch(step: string, patch: Partial<Given> = {}): Given {
    return {
      runtime: 'claude',
      runKey: 'k',
      step,
      attemptId: `attempt-${step}`,
      mounts: [{ hostPath: join(root, 'worktrees', 'k', 'demo'), containerPath: '/work/demo' }],
      allowHosts: [],
      command: ['agent'],
      userId: 501,
      ...patch,
    };
  }

  it('starts three checks and five agents of different runs at once', async () => {
    const sandbox = service();
    const checks = [0, 1, 2].map((index) =>
      sandbox.spawn(launch(`checks-${index}`, { runKey: `check-run-${index}`, command: [], project: projectLaunch })),
    );
    const agents = [0, 1, 2, 3, 4].map((index) =>
      sandbox.spawn(launch(`implement-${index}`, { runKey: `run-${index}` })),
    );
    await expect(Promise.all([...checks, ...agents])).resolves.toHaveLength(8);
    expect(children).toHaveLength(8);
  });

  it('gives every container the same memory cap and the lower CPU weight', async () => {
    const sandbox = service();
    const agent = await sandbox.spawn(launch('plan'));
    const check = await sandbox.spawn(launch('checks-0', { command: [], project: projectLaunch }));
    expect(runs).toHaveLength(2);
    for (const args of runs) {
      expect(args[args.indexOf('--memory') + 1]).toBe(`${2 * GB}b`);
      expect(args[args.indexOf('--cpu-shares') + 1]).toBe('512');
    }
    expect(agent.memoryCapBytes).toBe(2 * GB);
    expect(check.memoryCapBytes).toBe(2 * GB);
  });

  it('starts without a memory cap when docker does not tell its size', async () => {
    const sandbox = service(() => Promise.reject(new Error('down')));
    const child = await sandbox.spawn(launch('plan'));
    expect(runs[0]).not.toContain('--memory');
    expect(child.memoryCapBytes).toBeUndefined();
  });

  it('asks docker again on the next launch after it gave no answer', async () => {
    let answer: string | Error = new Error('down');
    const sandbox = service(() => (answer instanceof Error ? Promise.reject(answer) : answer));
    await sandbox.spawn(launch('plan'));
    answer = `4 ${5 * GB}`;
    const later = await sandbox.spawn(launch('review'));
    expect(later.memoryCapBytes).toBe(4 * GB);
  });

  it('keeps what docker said of its CPUs and memory, and asks again after a failure', async () => {
    let answer: string | Error = new Error('down');
    const sandbox = service(() => (answer instanceof Error ? Promise.reject(answer) : answer));
    expect(sandbox.knownMachine()).toBeUndefined();
    expect(await sandbox.machine()).toBeUndefined();
    expect(sandbox.knownMachine()).toBeUndefined();
    answer = `8 ${16 * GB}`;
    expect(await sandbox.machine()).toEqual({ cpus: 8, memoryBytes: 16 * GB });
    answer = new Error('down again');
    expect(await sandbox.machine()).toEqual({ cpus: 8, memoryBytes: 16 * GB });
    expect(sandbox.knownMachine()).toEqual({ cpus: 8, memoryBytes: 16 * GB });
  });

  it('takes the memory cap from the kept machine', async () => {
    const sandbox = service(() => `8 ${16 * GB}`);
    await sandbox.machine();
    const child = await sandbox.spawn(launch('plan'));
    expect(child.memoryCapBytes).toBe(15 * GB);
  });

  it('counts the work that runs and its last sample until it closes', async () => {
    const sandbox = service();
    let sampled = '';
    sandbox.useDocker(async (args) => {
      if (args[0] === 'info') {
        return `4 ${3 * GB}`;
      }
      if (args[0] === 'stats' && args[args.length - 1] === sampled) {
        return '50.0% 100MiB / 3GiB';
      }
      throw new Error('no answer');
    });
    const held = { onPaused: () => undefined };
    const agent = await sandbox.spawn(launch('plan', { attemptId: 'a' }), {
      ...held,
      agent: { step: 'plan', onWait: () => undefined },
    });
    const check = await sandbox.spawn(launch('checks-0', { command: [], project: projectLaunch }), {
      ...held,
      work: 'check',
    });
    const setup = await sandbox.spawn(launch('setup', { command: [], project: projectLaunch }), {
      ...held,
      work: 'setup',
    });
    await sandbox.spawn(launch('free'));
    expect(sandbox.work.load()).toMatchObject({ agents: 1, checks: 1, setups: 1 });
    sampled = agent.containerName;
    await sandbox.stats(agent.containerName);
    await sandbox.stats(check.containerName);
    expect(sandbox.work.load()).toMatchObject({ cpuPercent: 50, memoryBytes: 100 * 1024 ** 2 });
    check.emit('close');
    setup.emit('error');
    expect(sandbox.work.load()).toMatchObject({ agents: 1, checks: 0, setups: 0 });
  });

  it('releases nothing and leaves nothing behind when the spawn throws', async () => {
    const sandbox = service(undefined, true);
    await expect(sandbox.spawn(launch('plan'))).rejects.toThrow('docker run failed');
  });

  it('starts at once without a config, with the default reserve', async () => {
    const sandbox = new SandboxService();
    sandbox.useDocker(() => Promise.reject(new Error('down')));
    sandbox.spawnDocker = () => {
      const child = new EventEmitter() as SandboxChild;
      child.containerName = 'x';
      return child;
    };
    await expect(sandbox.spawn(launch('plan'))).resolves.toBeDefined();
  });

  describe('while the server is paused', () => {
    function gated(agents?: number): { sandbox: SandboxService; gate: ContainerGate; dockerCalls: string[][] } {
      const gate = new ContainerGate(agents ? new AppConfig(testEnv({ AGENTS_PARALLEL: agents })) : undefined);
      const sandbox = new SandboxService(new AppConfig(testEnv({ RESERVE_MEMORY_GB: 1 })), gate);
      const dockerCalls: string[][] = [];
      sandbox.useDocker(async (args) => {
        dockerCalls.push(args);
        return args[0] === 'info' ? `4 ${3 * GB}` : '';
      });
      sandbox.spawnDocker = (args) => {
        runs.push(args);
        const child = new EventEmitter() as SandboxChild;
        child.containerName = args[args.indexOf('--name') + 1] ?? '';
        children.push(child);
        return child;
      };
      return { sandbox, gate, dockerCalls };
    }

    it('holds a held spawn without a docker call, says so, and starts it after resume', async () => {
      const { sandbox, gate, dockerCalls } = gated();
      gate.pause();
      const told = jest.fn();
      const started = sandbox.spawn(launch('plan'), { onPaused: told });
      await new Promise((resolve) => setImmediate(resolve));
      expect(told).toHaveBeenCalledTimes(1);
      expect(dockerCalls).toEqual([]);
      expect(runs).toEqual([]);
      gate.resume();
      await started;
      expect(runs).toHaveLength(1);
    });

    it('holds a third agent spawn until one of two ends, and starts a spawn without an agent at once', async () => {
      const { sandbox } = gated(2);
      const hold = { onPaused: () => undefined, agent: { step: 'plan', onWait: () => undefined } };
      await sandbox.spawn(launch('plan'), hold);
      await sandbox.spawn(launch('plan'), hold);
      const third = sandbox.spawn(launch('plan'), hold);
      await new Promise((resolve) => setImmediate(resolve));
      expect(runs).toHaveLength(2);
      await sandbox.spawn(launch('plan'), { onPaused: () => undefined });
      expect(runs).toHaveLength(3);
      children[0]?.emit('close', 0);
      await third;
      expect(runs).toHaveLength(4);
    });

    it('starts held spawns in the order they came', async () => {
      const { sandbox, gate } = gated();
      gate.pause();
      const first = sandbox.spawn(launch('first'), { onPaused: () => undefined });
      const second = sandbox.spawn(launch('second'), { onPaused: () => undefined });
      gate.resume();
      await Promise.all([first, second]);
      expect(children.map((child) => child.containerName)).toEqual([
        expect.stringContaining('first'),
        expect.stringContaining('second'),
      ]);
    });

    it('starts a spawn that is not held, as sign-in does', async () => {
      const { sandbox, gate } = gated();
      gate.pause();
      await sandbox.spawn(launch('sign-in'));
      expect(runs).toHaveLength(1);
      expect(gate.running()).toBe(0);
    });

    it('takes a held spawn out of the wait when its run is stopped, and starts nothing after resume', async () => {
      const { sandbox, gate } = gated();
      gate.pause();
      const held = sandbox.spawn(launch('plan'), { onPaused: () => undefined });
      const outcome = held.catch((error: unknown) => error);
      await sandbox.stopRun('k', 'plan', 1);
      expect(await outcome).toBeInstanceOf(ContainerDropped);
      gate.resume();
      expect(runs).toEqual([]);
      expect(gate.running()).toBe(0);
    });

    it('counts a held container while it is being prepared, and not after the spawn fails', async () => {
      const { sandbox, gate } = gated();
      let answer!: (value: string) => void;
      sandbox.useDocker((args) =>
        args[0] === 'info' ? new Promise<string>((resolve) => (answer = resolve)) : Promise.resolve(''),
      );
      const starting = sandbox.spawn(launch('plan'), { onPaused: () => undefined });
      await new Promise((resolve) => setImmediate(resolve));
      expect(gate.running()).toBe(1);
      sandbox.spawnDocker = () => {
        throw new Error('docker run failed');
      };
      answer(`4 ${3 * GB}`);
      await expect(starting).rejects.toThrow('docker run failed');
      expect(gate.running()).toBe(0);
    });

    it('counts a held container until it closes, and a pause never stops it', async () => {
      const { sandbox, gate, dockerCalls } = gated();
      await sandbox.spawn(launch('plan'), { onPaused: () => undefined });
      expect(gate.running()).toBe(1);
      const before = dockerCalls.length;
      gate.pause();
      expect(gate.running()).toBe(1);
      expect(dockerCalls).toHaveLength(before);
      children[0]?.emit('close', 0);
      expect(gate.running()).toBe(0);
    });
  });
});
