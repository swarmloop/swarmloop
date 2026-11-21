import { checksAtOnce } from '../sandbox/core-slices';
import { CheckSlots } from './check-slots';

describe('CheckSlots', () => {
  it('numbers the places from 0 and keeps a command waiting when all are held', async () => {
    const slots = new CheckSlots(() => 3);
    const first = await slots.take('r', () => undefined);
    const second = await slots.take('r', () => undefined);
    const third = await slots.take('r', () => undefined);
    expect([first?.place, second?.place, third?.place]).toEqual([0, 1, 2]);
    const ahead: number[] = [];
    let fourth: number | undefined;
    void slots
      .take('r', (count) => ahead.push(count))
      .then((taken) => {
        fourth = taken?.place;
      });
    await Promise.resolve();
    expect(ahead).toEqual([0]);
    expect(fourth).toBeUndefined();
  });

  it('gives a released number again to the command that waits', async () => {
    const slots = new CheckSlots(() => 3);
    const taken = await Promise.all([0, 1, 2].map(() => slots.take('r', () => undefined)));
    const waiting = slots.take('r', () => undefined);
    taken[1]?.release();
    taken[1]?.release();
    expect((await waiting)?.place).toBe(1);
  });

  it('with 8 cores and CHECKS_PARALLEL 3 a third check waits and gets the place a finished one gave back', async () => {
    const slots = new CheckSlots(() => checksAtOnce(8, 3));
    const first = await slots.take('r', () => undefined);
    const second = await slots.take('r', () => undefined);
    const ahead: number[] = [];
    const third = slots.take('r', (count) => ahead.push(count));
    second?.release();
    expect([first?.place, second?.place, (await third)?.place]).toEqual([0, 1, 1]);
    expect(ahead).toEqual([0]);
  });

  it('never holds more places than the limit', async () => {
    const slots = new CheckSlots(() => 2);
    const places: number[] = [];
    const run = async (): Promise<void> => {
      const taken = await slots.take('r', () => undefined);
      places.push(taken?.place ?? -1);
      taken?.release();
    };
    await Promise.all([run(), run(), run(), run()]);
    expect(places.every((place) => place >= 0 && place < 2)).toBe(true);
  });

  it('gives null to a halted run and to a command that was dropped', async () => {
    const slots = new CheckSlots(
      () => 1,
      (key) => key === 'stopped',
    );
    expect(await slots.take('stopped', () => undefined)).toBeNull();
    const held = await slots.take('r', () => undefined);
    const waiting = slots.take('r', () => undefined);
    slots.drop('r');
    expect(await waiting).toBeNull();
    held?.release();
  });
});
