import { containerMemoryCap } from './memory-cap';

const GB = 1024 ** 3;

describe('containerMemoryCap', () => {
  it('is the memory Docker has less the reserve', async () => {
    const docker = jest.fn().mockResolvedValue(`${11 * GB}\n`);
    expect(await containerMemoryCap(docker, GB)).toBe(10 * GB);
  });

  it('is undefined when docker fails, gives garbage, or nothing is left after the reserve', async () => {
    expect(await containerMemoryCap(() => Promise.reject(new Error('down')), GB)).toBeUndefined();
    expect(await containerMemoryCap(() => Promise.resolve('n/a'), GB)).toBeUndefined();
    expect(await containerMemoryCap(() => Promise.resolve('0'), GB)).toBeUndefined();
    expect(await containerMemoryCap(() => Promise.resolve(`${GB}`), GB)).toBeUndefined();
  });
});
