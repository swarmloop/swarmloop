import { MachineBudget } from './machine-budget';
import type { DockerRunner } from './run-containers';

const GB = 1024 ** 3;
const small = { memoryBytes: GB };

/** 11 GB with a reserve of 1 GB: room for two checks of 4 GB. */
function budget(answer: string | Error = `${11 * GB}`): MachineBudget {
  const docker: DockerRunner = () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer));
  return new MachineBudget(docker, { memoryBytes: GB });
}

const check = { memoryBytes: 4 * GB };
const work = (label: string, alone = false, runKey = 'k') => ({
  kind: 'check' as const,
  runKey,
  name: 'test',
  label,
  alone,
});

async function settled(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('MachineBudget', () => {
  it('holds a third check back with the reason and starts it when one ends', async () => {
    const machine = budget();
    const first = await machine.acquire(work('a'), check);
    await machine.acquire(work('b'), check);
    const reasons: string[] = [];
    let started = false;
    const third = machine
      .acquire(work('c'), check, (reason) => reasons.push(reason))
      .then((release) => {
        started = true;
        return release;
      });
    await settled();
    expect(started).toBe(false);
    expect(reasons).toEqual(['waiting for machine resources: a, b']);
    first();
    await third;
    expect(started).toBe(true);
  });

  it('never hands out the reserve', async () => {
    const machine = budget();
    await machine.acquire(work('a'), check);
    await machine.acquire(work('b'), check);
    expect(machine.snapshot()).toMatchObject({ capacityMemoryBytes: 10 * GB, usedMemoryBytes: 8 * GB });
    let started = false;
    void machine.acquire(work('c'), { memoryBytes: 3 * GB }).then(() => {
      started = true;
    });
    await settled();
    expect(started).toBe(false);
  });

  it('runs work larger than the whole budget alone, and does not wait for ever', async () => {
    const machine = budget();
    const first = await machine.acquire(work('a'), small);
    let started = false;
    const big = machine.acquire(work('big'), { memoryBytes: 40 * GB }).then((release) => {
      started = true;
      return release;
    });
    await settled();
    expect(started).toBe(false);
    first();
    const release = await big;
    let beside = false;
    void machine.acquire(work('b'), small).then(() => {
      beside = true;
    });
    await settled();
    expect(beside).toBe(false);
    release();
    await settled();
    expect(beside).toBe(true);
  });

  it('runs work that asks to be alone with nothing beside it', async () => {
    const machine = budget();
    const first = await machine.acquire(work('a'), small);
    let started = false;
    void machine.acquire(work('retry', true), small).then(() => {
      started = true;
    });
    await settled();
    expect(started).toBe(false);
    first();
    await settled();
    expect(started).toBe(true);
  });

  it('serves the queue first come first served: a blocked head holds the smaller work behind it', async () => {
    const machine = budget();
    const first = await machine.acquire(work('a'), check);
    await machine.acquire(work('b'), check);
    const order: string[] = [];
    void machine.acquire(work('big'), check).then(() => order.push('big'));
    void machine.acquire(work('small'), small).then(() => order.push('small'));
    await settled();
    expect(machine.snapshot().waiting).toEqual(['big', 'small']);
    first();
    await settled();
    expect(order).toEqual(['big', 'small']);
  });

  it('tells a waiting piece again when what runs changes, and tells nothing to work that starts at once', async () => {
    const machine = budget();
    const told: string[] = [];
    const first = await machine.acquire(work('a'), check, (reason) => told.push(reason));
    const second = await machine.acquire(work('b'), check);
    expect(told).toEqual([]);
    void machine.acquire(work('c'), check);
    void machine.acquire(work('d'), check, (reason) => told.push(reason));
    await settled();
    first();
    await settled();
    expect(told).toEqual(['waiting for machine resources: a, b', 'waiting for machine resources: b, c']);
    second();
  });

  it('drops the waiting launches of a stopped run, and lets the next in line start', async () => {
    const machine = budget();
    const first = await machine.acquire(work('a'), check);
    await machine.acquire(work('b'), check);
    const dropped = machine.acquire(work('c', false, 'stopped'), check);
    const rejection = expect(dropped).rejects.toThrow('the run was stopped');
    let started = false;
    void machine.acquire(work('d'), check).then(() => {
      started = true;
    });
    await settled();
    machine.cancelWaiting('stopped');
    await rejection;
    expect(machine.snapshot().waiting).toEqual(['d']);
    first();
    await settled();
    expect(started).toBe(true);
  });

  it('lets a release run only once', async () => {
    const machine = budget();
    const first = await machine.acquire(work('a'), check);
    await machine.acquire(work('b'), check);
    first();
    first();
    expect(machine.snapshot().running).toEqual(['b']);
    await machine.acquire(work('c'), check);
    let started = false;
    void machine.acquire(work('d'), check).then(() => {
      started = true;
    });
    await settled();
    expect(started).toBe(false);
  });

  it('shows what runs and what waits', async () => {
    const machine = budget();
    await machine.acquire(work('a'), check);
    await machine.acquire(work('b'), check);
    void machine.acquire(work('c'), check);
    await settled();
    expect(machine.snapshot()).toMatchObject({ running: ['a', 'b'], waiting: ['c'], usedMemoryBytes: 8 * GB });
  });

  it.each([new Error('docker is down'), 'nonsense', '0 0', ''])(
    'puts no limit on a docker answer of %s',
    async (answer) => {
      const machine = budget(answer);
      await machine.acquire(work('a'), check);
      await machine.acquire(work('b'), check);
      await machine.acquire(work('c'), check);
      expect(machine.snapshot().capacityMemoryBytes).toBe(0);
    },
  );
});
