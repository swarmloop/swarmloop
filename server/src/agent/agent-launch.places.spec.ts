import { EventEmitter } from 'events';
import { mkdirSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import { ContainerDropped, ContainerGate } from '../sandbox/container-gate';
import { heldSpawn } from '../sandbox/container-gate.spec-helpers';
import { AgentProcessRunner } from './agent-runner';
import { RunStop } from './run-stop';
import { config, fakeChild, input, sandbox, stubbornChild, writePriceCache } from './agent-runner.spec-helpers';

type Child = EventEmitter;

/** Every way an agent start can wait or end, with one agent place: the place must be free once the launch is over. */
async function setup(
  children: (() => Promise<Child>)[],
  env: Parameters<typeof config>[1] = {},
  patch: Partial<Parameters<typeof input>[2]> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-agent-places-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  writePriceCache(root);
  const cfg = config(root, { AGENTS_PARALLEL: 1, ...env });
  const gate = new ContainerGate(cfg);
  const spawn = jest.fn(heldSpawn(gate, () => (children.shift() as () => Promise<Child>)()));
  const clock = new FakeClock();
  const runner = new AgentProcessRunner(cfg, clock, sandbox(spawn), new RunStop());
  const run = (name: string, outputFile = join(root, 'data', `run1-${name}-output.txt`)) =>
    runner.run(input(root, outputFile, { resumeChatId: null, ...patch }));
  return { root, gate, run, clock };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const noPlace = { steps: [], running: 0 };
const placeOf = (gate: ContainerGate) => {
  const { steps, running } = gate.agentWait('run1');
  return { steps, running };
};

describe('an agent place after a launch ends', () => {
  it('comes back after a normal end', async () => {
    const { gate, run } = await setup([() => Promise.resolve(fakeChild(['x\n'], 0))]);
    await run('normal');
    expect(placeOf(gate)).toEqual(noPlace);
  });

  it('comes back after a process that died', async () => {
    const child = fakeChild([], 0);
    child.on = EventEmitter.prototype.on.bind(child);
    const { gate, run } = await setup([() => Promise.resolve(child), () => Promise.resolve(fakeChild(['x\n'], 0))]);
    const ended = run('died');
    while (child.listenerCount('error') < 3) {
      await settle();
    }
    child.emit('error', Object.assign(new Error('gone'), { code: 'EPIPE' }));
    await ended;
    expect(placeOf(gate)).toEqual(noPlace);
  });

  it('comes back after a throw before the container starts', async () => {
    const { gate, run } = await setup([() => Promise.reject(new Error('docker run failed'))]);
    await expect(run('throw-before')).rejects.toThrow('docker run failed');
    expect(placeOf(gate)).toEqual(noPlace);
  });

  it('comes back after a usage-limit end', async () => {
    const stream = `${JSON.stringify({ type: 'result', is_error: true, result: "You've hit your usage limit" })}\n`;
    const { gate, run } = await setup([() => Promise.resolve(fakeChild([stream], 1))]);
    await run('limit');
    expect(placeOf(gate)).toEqual(noPlace);
  });

  it('is handed to the next start once a start held by the server pause goes on and ends', async () => {
    const { gate, run } = await setup([() => Promise.resolve(fakeChild(['x\n'], 0))]);
    gate.pause();
    const held = run('paused');
    await settle();
    expect(gate.running()).toBe(0);
    gate.resume();
    await held;
    expect(placeOf(gate)).toEqual(noPlace);
  });

  it('is not held by a Stop that took a start out of the line', async () => {
    const open = fakeChild([], 0);
    open.on = EventEmitter.prototype.on.bind(open);
    const { gate, run } = await setup([() => Promise.resolve(open)]);
    const first = run('first');
    while (gate.agentWait('run1').running < 1) {
      await settle();
    }
    const second = run('second');
    while (gate.agentWait('run1').steps.length < 1) {
      await settle();
    }
    expect(gate.agentWait('run1').steps).toEqual(['implement']);
    gate.drop('run1');
    await expect(second).rejects.toBeInstanceOf(ContainerDropped);
    open.emit('close', 0);
    await first;
    expect(placeOf(gate)).toEqual(noPlace);
  });

  it('comes back after a result end whose docker client ignores SIGTERM', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      const result = `${JSON.stringify({ type: 'result', result: 'done' })}\n`;
      const { gate, run } = await setup([() => Promise.resolve(stubbornChild([result]))]);
      const ended = run('result');
      let over = false;
      void ended.then(() => (over = true));
      while (!over) {
        await settle();
        await jest.advanceTimersByTimeAsync(1_000);
      }
      await ended;
      expect(placeOf(gate)).toEqual(noPlace);
    } finally {
      jest.useRealTimers();
    }
  });

  it('comes back after a throw once the container started', async () => {
    const { root, gate, run } = await setup([() => Promise.resolve(stubbornChild([]))]);
    writeFileSync(join(root, 'not-a-folder'), 'x');
    await expect(run('throw-after', join(root, 'not-a-folder', 'run1-implement-output.txt'))).rejects.toThrow();
    await settle();
    expect(placeOf(gate)).toEqual(noPlace);
  });

  it('comes back after a model host outage end', async () => {
    const stream = `${JSON.stringify({ type: 'result', is_error: true, terminal_reason: 'api_error', result: 'API Error: 502 ENOTFOUND api.anthropic.com' })}\n`;
    const { gate, run } = await setup([() => Promise.resolve(fakeChild([stream], 1))], {}, { runtime: 'claude' });
    const result = await run('outage');
    expect(result.outage).toBeDefined();
    expect(placeOf(gate)).toEqual(noPlace);
  });

  it.each([
    ['time', {}, { timeLimitMs: 20_000 }],
    ['idle', { IDLE_TIMEOUT_MS: 10_000 }, {}],
  ] as const)('comes back after a %s kill', async (reason, env, patch) => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      const child = stubbornChild(['{"type":"thinking","text":"x"}\n']);
      const killable = child as unknown as { kill: (signal: string) => boolean };
      const ignoring = killable.kill;
      killable.kill = (signal) => {
        if (signal === 'SIGTERM') setImmediate(() => child.emit('close', 143));
        return ignoring(signal);
      };
      const { gate, run, clock } = await setup([() => Promise.resolve(child)], env, { continuePrompt: null, ...patch });
      const ended = run(reason);
      let over = false;
      void ended.then(() => (over = true));
      while (!over) {
        await settle();
        clock.advance(5_000);
        await jest.advanceTimersByTimeAsync(5_000);
      }
      expect((await ended).killReason).toBe(reason);
      expect(placeOf(gate)).toEqual(noPlace);
    } finally {
      jest.useRealTimers();
    }
  });
});
