import { StartHold } from './start-hold';

describe('StartHold', () => {
  it('tells a wait each time the start waits, and once more when the spawn is over', async () => {
    const told: string[] = [];
    const hold = new StartHold(() => Promise.resolve(void told.push('told')));
    expect(hold.wasHeld).toBe(false);
    hold.waits();
    hold.waits();
    expect(hold.wasHeld).toBe(true);
    await hold.spawned();
    expect(told).toHaveLength(3);
  });

  it('resolves only when every call is done', async () => {
    let finish!: () => void;
    const slow = new Promise<void>((resolve) => (finish = resolve));
    let over = false;
    const hold = new StartHold(() => slow);
    hold.waits();
    void hold.spawned().then(() => (over = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(over).toBe(false);
    finish();
    await slow;
    await new Promise((resolve) => setImmediate(resolve));
    expect(over).toBe(true);
  });

  it('does nothing without an owner for the wait', async () => {
    const hold = new StartHold();
    hold.waits();
    await expect(hold.spawned()).resolves.toBeUndefined();
    expect(hold.wasHeld).toBe(true);
  });
});
