import { KeyedQueue } from './keyed-queue';

describe('KeyedQueue', () => {
  it('runs the work of one key one at a time, in call order, and the work of other keys without waiting', async () => {
    const queue = new KeyedQueue();
    const events: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = queue.run('a', async () => {
      events.push('first start');
      await gate;
      events.push('first end');
    });
    const second = queue.run('a', async () => {
      events.push('second');
    });
    await queue.run('b', async () => {
      events.push('other key');
    });
    expect(events).toEqual(['first start', 'other key']);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(['first start', 'other key', 'first end', 'second']);
  });

  it('returns the result, and a failed work does not block the next', async () => {
    const queue = new KeyedQueue();
    const failed = queue.run('a', () => Promise.reject(new Error('no')));
    const next = queue.run('a', () => Promise.resolve(7));
    await expect(failed).rejects.toThrow('no');
    await expect(next).resolves.toBe(7);
  });

  it('keeps no record of a key once its last work is done', async () => {
    const queue = new KeyedQueue();
    const work = queue.run('a', () => Promise.resolve());
    expect(queue.pending()).toBe(1);
    await work;
    await new Promise((resolve) => setImmediate(resolve));
    expect(queue.pending()).toBe(0);
  });
});
