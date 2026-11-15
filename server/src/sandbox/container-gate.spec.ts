import { ContainerDropped, ContainerGate } from './container-gate';

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
});
