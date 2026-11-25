import { AppConfig } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import { ContainerDropped, ContainerGate } from './container-gate';
import type { AgentHold } from './container-gate';

describe('ContainerGate', () => {
  it('starts not paused with nothing running', () => {
    const gate = new ContainerGate();
    expect(gate.paused()).toBe(false);
    expect(gate.running()).toBe(0);
  });

  it('lets a start through at once when not paused', async () => {
    const onPaused = jest.fn();
    await new ContainerGate().admit(onPaused, 'run');
    expect(onPaused).not.toHaveBeenCalled();
  });

  it('holds starts while paused, says so once each, and lets them through in order on resume', async () => {
    const gate = new ContainerGate();
    gate.pause();
    const order: string[] = [];
    const said: string[] = [];
    const first = gate.admit(() => said.push('first'), 'run').then(() => order.push('first'));
    const second = gate.admit(() => said.push('second'), 'run').then(() => order.push('second'));
    await Promise.resolve();
    expect(order).toEqual([]);
    expect(said).toEqual(['first', 'second']);
    gate.resume();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });

  it('counts a container from its admission until its release, and a second release does not count twice', async () => {
    const gate = new ContainerGate();
    const first = await gate.admit(jest.fn(), 'run');
    const second = await gate.admit(jest.fn(), 'run');
    expect(gate.running()).toBe(2);
    first();
    first();
    expect(gate.running()).toBe(1);
    second();
    expect(gate.running()).toBe(0);
  });

  it('tells listeners only when the pause changes, until they unsubscribe', () => {
    const gate = new ContainerGate();
    const seen: boolean[] = [];
    const stop = gate.onChange((paused) => seen.push(paused));
    gate.resume();
    gate.pause();
    gate.pause();
    gate.resume();
    stop();
    gate.pause();
    expect(seen).toEqual([true, false]);
  });

  it('leaves a running container counted when it pauses', async () => {
    const gate = new ContainerGate();
    await gate.admit(jest.fn(), 'run');
    gate.pause();
    expect(gate.running()).toBe(1);
  });

  it('takes the containers of a stopped run out of the wait and starts nothing for them after resume', async () => {
    const gate = new ContainerGate();
    gate.pause();
    const stopped = gate.admit(jest.fn(), 'stopped');
    const other = gate.admit(jest.fn(), 'other');
    gate.drop('stopped');
    await expect(stopped).rejects.toBeInstanceOf(ContainerDropped);
    gate.resume();
    await other;
    expect(gate.running()).toBe(1);
  });

  describe('with a limit on agents', () => {
    const limited = (limit: number): ContainerGate =>
      new ContainerGate(new AppConfig(testEnv({ AGENTS_PARALLEL: limit })));
    const hold = (step: string, told: string[] = []): AgentHold => ({ step, onWait: (text) => told.push(text) });
    const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

    it('with a limit of 2, a third agent waits until one of two ends, then starts', async () => {
      const gate = limited(2);
      const first = await gate.admit(jest.fn(), 'run', hold('a'));
      await gate.admit(jest.fn(), 'run', hold('b'));
      let started = false;
      const third = gate.admit(jest.fn(), 'run', hold('c')).then(() => (started = true));
      await flush();
      expect(started).toBe(false);
      expect(gate.running()).toBe(2);
      first();
      await third;
      expect(gate.running()).toBe(2);
    });

    it('starts held agents in the order they came', async () => {
      const gate = limited(1);
      const first = await gate.admit(jest.fn(), 'run', hold('a'));
      const order: string[] = [];
      const releases: (() => void)[] = [];
      const queue = ['b', 'c', 'd'].map((step) =>
        gate.admit(jest.fn(), 'run', hold(step)).then((release) => {
          order.push(step);
          releases.push(release);
        }),
      );
      await flush();
      first();
      await flush();
      releases[0]?.();
      await flush();
      releases[1]?.();
      await Promise.all(queue);
      expect(order).toEqual(['b', 'c', 'd']);
    });

    it('does not count check containers in the agent limit', async () => {
      const gate = limited(2);
      await gate.admit(jest.fn(), 'run', hold('a'));
      await gate.admit(jest.fn(), 'run', hold('b'));
      await gate.admit(jest.fn(), 'run');
      await gate.admit(jest.fn(), 'run');
      expect(gate.running()).toBe(4);
      expect(gate.agentWait('run').running).toBe(2);
    });

    it('a Stop takes a held agent out of the line and the next one starts on a free place', async () => {
      const gate = limited(1);
      const first = await gate.admit(jest.fn(), 'busy', hold('a'));
      const stopped = gate.admit(jest.fn(), 'stopped', hold('b'));
      const next = gate.admit(jest.fn(), 'other', hold('c'));
      await flush();
      gate.drop('stopped');
      await expect(stopped).rejects.toBeInstanceOf(ContainerDropped);
      first();
      await next;
      expect(gate.running()).toBe(1);
    });

    it('lets agents under the limit start at once without saying anything', async () => {
      const told: string[] = [];
      const gate = limited(2);
      await gate.admit(jest.fn(), 'run', hold('a', told));
      await gate.admit(jest.fn(), 'run', hold('b', told));
      expect(told).toEqual([]);
    });

    it('tells a held agent once that it waits, with the busy places', async () => {
      const told: string[] = [];
      const gate = limited(1);
      const first = await gate.admit(jest.fn(), 'run', hold('a'));
      const second = gate.admit(jest.fn(), 'run', hold('b', told));
      await flush();
      first();
      await second;
      expect(told).toEqual(['Waiting for a free agent place (1 of 1 busy)']);
    });

    it('after a pause, agents beyond the limit wait in the line in arrival order', async () => {
      const gate = limited(1);
      gate.pause();
      const order: string[] = [];
      const releases: (() => void)[] = [];
      const all = ['a', 'b', 'c'].map((step) =>
        gate.admit(jest.fn(), 'run', hold(step)).then((release) => {
          order.push(step);
          releases.push(release);
        }),
      );
      gate.resume();
      await flush();
      expect(order).toEqual(['a']);
      releases[0]?.();
      await flush();
      releases[1]?.();
      await Promise.all(all);
      expect(order).toEqual(['a', 'b', 'c']);
    });

    it('hands out no place while paused, and starts the waiting agent on resume', async () => {
      const gate = limited(1);
      const first = await gate.admit(jest.fn(), 'run', hold('a'));
      const paused = jest.fn();
      let started = false;
      const second = gate.admit(paused, 'run', hold('b')).then(() => (started = true));
      await flush();
      gate.pause();
      expect(paused).toHaveBeenCalledTimes(1);
      first();
      await flush();
      expect(started).toBe(false);
      gate.resume();
      await second;
      expect(gate.running()).toBe(1);
    });

    it('agentWait names the waiting steps of a run and its running agents', async () => {
      const gate = limited(1);
      await gate.admit(jest.fn(), 'one', hold('plan'));
      void gate.admit(jest.fn(), 'two', hold('implement')).catch(() => undefined);
      void gate.admit(jest.fn(), 'two', hold('code-review-a')).catch(() => undefined);
      await flush();
      expect(gate.agentWait('two')).toEqual({
        steps: ['implement', 'code-review-a'],
        running: 0,
        text: 'Waiting for a free agent place (1 of 1 busy)',
      });
      expect(gate.agentWait('one').running).toBe(1);
      gate.drop('two');
    });
    describe('startWait', () => {
      const place = 'Waiting for a free agent place (1 of 1 busy)';

      it('gives the words only when an agent of the run waits and none of its agents runs', async () => {
        const gate = limited(1);
        const release = await gate.admit(jest.fn(), 'one', hold('plan'));
        expect(gate.startWait('one')).toBeNull();
        void gate.admit(jest.fn(), 'two', hold('implement')).catch(() => undefined);
        await flush();
        expect(gate.startWait('two')).toEqual({ code: 'AGENT_PLACE', message: place });
        expect(gate.startWait('one')).toBeNull();
        release();
        await flush();
        expect(gate.startWait('two')).toBeNull();
        expect(gate.startWait('none')).toBeNull();
      });

      it('gives the pause while an agent start of the run is held by it or waits in the line, and not for a check', async () => {
        const gate = limited(1);
        await gate.admit(jest.fn(), 'one', hold('plan'));
        void gate.admit(jest.fn(), 'two', hold('implement')).catch(() => undefined);
        await flush();
        gate.pause();
        void gate.admit(jest.fn(), 'three', hold('plan')).catch(() => undefined);
        void gate.admit(jest.fn(), 'check').catch(() => undefined);
        await flush();
        expect(gate.startWait('two')).toMatchObject({ code: 'SERVER_PAUSE' });
        expect(gate.startWait('three')).toMatchObject({ code: 'SERVER_PAUSE' });
        expect(gate.startWait('check')).toBeNull();
        expect(gate.startWait('one')).toBeNull();
        gate.resume();
        expect(gate.startWait('two')).toEqual({ code: 'AGENT_PLACE', message: place });
        gate.drop('two');
        gate.drop('three');
        gate.drop('check');
      });
    });
  });
});
