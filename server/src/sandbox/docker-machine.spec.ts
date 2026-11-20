import { readDockerEngine, readDockerMachine } from './docker-machine';

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

describe('readDockerEngine', () => {
  it('reads the version from the server version of docker', async () => {
    const asked: string[][] = [];
    const version = await readDockerEngine((args) => {
      asked.push(args);
      return Promise.resolve('26.1.4\n');
    });
    expect(version).toBe('26.1.4');
    expect(asked[0]).toEqual(['version', '--format', '{{.Server.Version}}']);
    expect(await readDockerEngine(() => Promise.resolve('25.0.3-ce'))).toBe('25.0.3-ce');
  });

  it('is undefined when docker fails or the answer is no version', async () => {
    expect(await readDockerEngine(() => Promise.reject(new Error('down')))).toBeUndefined();
    for (const raw of ['', 'n/a', '8 16750372454', '<no value>']) {
      expect(await readDockerEngine(() => Promise.resolve(raw))).toBeUndefined();
    }
  });
});
