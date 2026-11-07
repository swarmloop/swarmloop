import 'reflect-metadata';
import type { AppConfig } from '../config/env';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import type { RunEntity } from '../history/entities';
import { RunStop } from '../agent/run-stop';
import { SandboxService } from '../sandbox/sandbox.service';
import { AgentLauncher } from '../steps/shared/agent-launcher';
import { StepStopped } from '../steps/shared/step-stopped';
import { RunDriver } from './run-driver';
import { RunLifecycle } from './run-lifecycle';

interface FakeContainer {
  id: string;
  name: string;
  run?: string;
}

/** A docker that lists containers by label and by name, as the real one does, and records every call. */
function fakeDocker(containers: FakeContainer[], options: { silent?: boolean; stubborn?: boolean } = {}) {
  const calls: string[][] = [];
  const docker = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (options.silent) throw new Error('Cannot connect to the Docker daemon');
    if (args[0] === 'ps') {
      const filter = args[args.indexOf('--filter') + 1];
      const [kind, ...rest] = filter.split('=');
      const value = rest.join('=');
      if (kind === 'label') {
        return containers
          .filter((item) => item.run === value.replace('swarmloop.run=', ''))
          .map((item) => item.id)
          .join('\n');
      }
      return containers
        .filter((item) => item.name.includes(value))
        .map((item) => item.name)
        .join('\n');
    }
    const target = args[args.length - 1];
    const index = containers.findIndex((item) => item.id === target || item.name === target);
    if (index === -1) throw new Error(`Error response from daemon: No such container: ${target}`);
    if (args[0] === 'kill' || !options.stubborn) containers.splice(index, 1);
    return '';
  };
  return { docker, calls };
}

function sandboxWith(docker: ReturnType<typeof fakeDocker>['docker']): SandboxService {
  const sandbox = new SandboxService();
  sandbox.useDocker(docker);
  return sandbox;
}

describe('SandboxService.stopRun', () => {
  it('stops gracefully, then kills, then lists by label again', async () => {
    const containers = [{ id: 'c1', name: 'swarmloop-key-1-implement', run: 'KEY-1' }];
    const fake = fakeDocker(containers, { stubborn: true });

    const result = await sandboxWith(fake.docker).stopRun('KEY-1', 'implement', 7);

    expect(result).toBe('gone');
    const verbs = fake.calls.map((args) => args[0]);
    expect(fake.calls).toContainEqual(['stop', '-t', '7', 'c1']);
    expect(verbs.indexOf('stop')).toBeLessThan(verbs.indexOf('kill'));
    expect(verbs.lastIndexOf('ps')).toBeGreaterThan(verbs.indexOf('kill'));
    expect(fake.calls[0]).toEqual(['ps', '-q', '--filter', 'label=swarmloop.run=KEY-1']);
  });

  it('does not touch a container of another run with a similar name', async () => {
    const containers = [
      { id: 'c1', name: 'swarmloop-key-1-implement', run: 'KEY-1' },
      { id: 'c10', name: 'swarmloop-key-10-implement', run: 'KEY-10' },
    ];
    const fake = fakeDocker(containers);

    await sandboxWith(fake.docker).stopRun('KEY-1', 'implement', 10);

    expect(containers.map((item) => item.id)).toEqual(['c10']);
    expect(fake.calls.flat()).not.toContain('c10');
    expect(fake.calls.flat()).not.toContain('swarmloop-key-10-implement');
  });

  it('finds a container that was started before the labels by its name', async () => {
    const containers = [{ id: 'old', name: 'swarmloop-key-1-code-review-security' }];
    const fake = fakeDocker(containers);

    expect(await sandboxWith(fake.docker).stopRun('KEY-1', 'code-review', 10)).toBe('gone');
    expect(containers).toEqual([]);
  });

  it('is unknown when docker does not answer', async () => {
    expect(await sandboxWith(fakeDocker([], { silent: true }).docker).stopRun('KEY-1', 'implement', 10)).toBe(
      'unknown',
    );
  });
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function lifecycleWith(run: Partial<RunEntity>, stopRun: jest.Mock) {
  const state = { ...run } as RunEntity;
  const released: { status: string; code?: string }[] = [];
  const runs = {
    findRun: jest.fn(async () => state),
    release: jest.fn(async (_run: RunEntity, change: { status: string; reason?: { code: string } }) => {
      released.push({ status: change.status, code: change.reason?.code });
      return state;
    }),
  };
  const runStop = new RunStop();
  const lifecycle = new RunLifecycle(
    runs as never,
    { latestBody: async () => null } as never,
    {} as never,
    { env: { STOP_GRACE_S: 10 } } as unknown as AppConfig,
    {} as never,
    runStop,
    new FakeClock(),
    { stopRun } as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const claim = () => (lifecycle as unknown as { inflight: Set<string> }).inflight.add(state.key);
  const leave = () => (lifecycle as unknown as { release(key: string): void }).release(state.key);
  return { lifecycle, runStop, state, released, claim, leave };
}

const RUNNING = { key: 'KEY-1', status: 'running', currentStep: 'implement' } as const;

describe('RunLifecycle.stop', () => {
  it('writes stopped only when no labeled container of the run is listed', async () => {
    const listed = ['c1'];
    const listedAtRelease: number[] = [];
    const stopRun = jest.fn(async () => {
      listed.length = 0;
      return 'gone';
    });
    const world = lifecycleWith(RUNNING, stopRun);
    (world.lifecycle as never as { runs: { release: jest.Mock } }).runs.release.mockImplementation(async () => {
      listedAtRelease.push(listed.length);
      world.released.push({ status: 'blocked', code: 'STOPPED' });
      return world.state;
    });

    const result = await world.lifecycle.stop('KEY-1');

    expect(result).toEqual({ exitCode: 0, message: 'KEY-1 stopped' });
    expect(world.released).toEqual([{ status: 'blocked', code: 'STOPPED' }]);
    expect(listedAtRelease).toEqual([0]);
    expect(stopRun).toHaveBeenCalledWith('KEY-1', 'implement', 10);
    expect(world.runStop.halted('KEY-1')).toBe(false);
  });

  it('is blocked with RESOURCE_UNKNOWN, never stopped, when docker does not answer', async () => {
    const world = lifecycleWith(RUNNING, jest.fn().mockResolvedValue('unknown'));

    const result = await world.lifecycle.stop('KEY-1');

    expect(result.exitCode).toBe(1);
    expect(world.released).toEqual([{ status: 'blocked', code: 'RESOURCE_UNKNOWN' }]);
    expect(world.runStop.halted('KEY-1')).toBe(true);
  });

  it('does not release a run that a container is still listed for', async () => {
    const world = lifecycleWith(RUNNING, jest.fn().mockResolvedValueOnce('gone').mockResolvedValueOnce('unknown'));

    const result = await world.lifecycle.stop('KEY-1');

    expect(result.exitCode).toBe(1);
    expect(world.released.map((item) => item.code)).toEqual(['RESOURCE_UNKNOWN']);
  });

  it('keeps the outcome of a step that finalized while the Stop waited for it', async () => {
    const gate = deferred();
    const stopRun = jest.fn(async () => {
      await gate.promise;
      return 'gone';
    });
    const world = lifecycleWith(RUNNING, stopRun);
    world.claim();

    const stopping = world.lifecycle.stop('KEY-1');
    await Promise.resolve();
    // The step closes as waiting and the driver leaves, then the kill returns.
    world.state.status = 'waiting';
    world.leave();
    gate.resolve();
    await stopping;

    expect(world.released).toEqual([]);
    expect(world.runStop.halted('KEY-1')).toBe(false);
  });

  it('turns a step that the kill made fail into stopped', async () => {
    const gate = deferred();
    const world = lifecycleWith(
      RUNNING,
      jest.fn(async () => (await gate.promise, 'gone')),
    );
    world.claim();

    const stopping = world.lifecycle.stop('KEY-1');
    await Promise.resolve();
    world.state.status = 'failed';
    world.leave();
    gate.resolve();
    await stopping;

    expect(world.released).toEqual([{ status: 'blocked', code: 'STOPPED' }]);
  });

  it('leaves a run that is not running and has no intent alone', async () => {
    const stopRun = jest.fn();
    const world = lifecycleWith({ ...RUNNING, status: 'waiting' }, stopRun);

    expect(await world.lifecycle.stop('KEY-1')).toEqual({ exitCode: 0, message: 'KEY-1 is stopped' });
    expect(stopRun).not.toHaveBeenCalled();
  });

  it('finishes a Stop whose intent survived a restart, even though the run is no longer running', async () => {
    const world = lifecycleWith({ ...RUNNING, status: 'failed' }, jest.fn().mockResolvedValue('gone'));
    world.runStop.halt('KEY-1');

    await world.lifecycle.stop('KEY-1');

    expect(world.released).toEqual([{ status: 'blocked', code: 'STOPPED' }]);
  });
});

describe('RunDriver with a Stop', () => {
  function driverWith(runStop: RunStop, execute: jest.Mock) {
    return new RunDriver(
      { findRun: async () => null } as never,
      {} as never,
      { get: () => ({ execute }) } as never,
      { env: { MAX_LAUNCHES: 3, MAX_RETURNS: 3, MAX_RUN_USD: 50 } } as unknown as AppConfig,
      {} as never,
      runStop,
      new FakeClock(),
      { flush: async () => undefined } as never,
    );
  }

  it('starts no hop once the intent is stored', async () => {
    const runStop = new RunStop();
    runStop.halt('KEY-1');
    const execute = jest.fn();

    await driverWith(runStop, execute).drive('implement', 'KEY-1', {});

    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['implement', 'code-review', 'pipeline'] as const)(
    'starts no next step when a Stop arrives during %s',
    async (step) => {
      const runStop = new RunStop();
      const execute = jest.fn(async () => {
        runStop.halt('KEY-1');
        return { exitCode: 1, message: 'killed' };
      });

      await driverWith(runStop, execute).drive(step, 'KEY-1', {});

      expect(execute).toHaveBeenCalledTimes(1);
    },
  );
});

describe('AgentLauncher with a Stop', () => {
  it('starts no agent once the intent is stored', async () => {
    const runStop = new RunStop();
    runStop.halt('KEY-1');
    const run = jest.fn();

    await expect(
      new AgentLauncher({ run } as never, {} as never, runStop).launch({ key: 'KEY-1' } as never),
    ).rejects.toBeInstanceOf(StepStopped);
    expect(run).not.toHaveBeenCalled();
  });
});
