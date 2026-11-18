import { readDockerMachine } from './docker-machine';

describe('readDockerMachine', () => {
  it('reads the CPUs and the memory', async () => {
    const asked: string[][] = [];
    const machine = await readDockerMachine((args) => {
      asked.push(args);
      return Promise.resolve('8 16777216000\n');
    });
    expect(machine).toEqual({ cpus: 8, memoryBytes: 16777216000 });
    expect(asked[0]).toEqual(['info', '--format', '{{.NCPU}} {{.MemTotal}}']);
  });

  it('is undefined when docker fails or gives anything but two positive numbers', async () => {
    expect(await readDockerMachine(() => Promise.reject(new Error('down')))).toBeUndefined();
    for (const raw of ['', 'n/a', '8', '8 n/a', '0 100', '8 0', '8 100 3']) {
      expect(await readDockerMachine(() => Promise.resolve(raw))).toBeUndefined();
    }
  });
});
