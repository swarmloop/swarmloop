import { SAMPLE_MS } from '../core/awake-time';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import { RunningWork } from './running-work';
import { SandboxService } from './sandbox.service';

const LISTING = ['one 10.0% 1MiB / 3GiB', 'two 20.0% 2MiB / 3GiB', 'three 30.0% 3MiB / 3GiB', ''].join('\n');

function setup(answer: () => Promise<string>) {
  const clock = new FakeClock();
  const work = new RunningWork();
  const sandbox = new SandboxService(undefined, undefined, work, clock);
  const calls: string[][] = [];
  sandbox.useDocker(async (args) => {
    calls.push(args);
    return answer();
  });
  return { clock, work, sandbox, calls };
}

describe('container stats', () => {
  it('shares one docker listing between callers in a window', async () => {
    const { sandbox, work, calls } = setup(async () => LISTING);
    work.start('one', 'agent');
    work.start('two', 'check');
    work.start('three', 'setup');
    const results = await Promise.all(['one', 'two', 'three'].map((name) => sandbox.stats(name)));
    expect(calls).toEqual([['stats', '--no-stream', '--format', '{{.Name}} {{.CPUPerc}} {{.MemUsage}}']]);
    expect(results).toEqual([
      { cpuPercent: 10, rssBytes: 1024 ** 2 },
      { cpuPercent: 20, rssBytes: 2 * 1024 ** 2 },
      { cpuPercent: 30, rssBytes: 3 * 1024 ** 2 },
    ]);
    expect(work.load()).toMatchObject({ cpuPercent: 60, memoryBytes: 6 * 1024 ** 2 });
  });

  it('answers 0 and 0 for a name the listing lacks, without a running-work sample', async () => {
    const { sandbox, work } = setup(async () => LISTING);
    work.start('absent', 'agent');
    await expect(sandbox.stats('absent')).resolves.toEqual({ cpuPercent: 0, rssBytes: 0 });
    expect(work.load()).toMatchObject({ cpuPercent: 0, memoryBytes: 0 });
  });

  it('answers 0 and 0 when the call fails', async () => {
    const { sandbox } = setup(() => Promise.reject(new Error('down')));
    await expect(sandbox.stats('one')).resolves.toEqual({ cpuPercent: 0, rssBytes: 0 });
  });

  it('starts a second call after SAMPLE_MS', async () => {
    const { sandbox, clock, calls } = setup(async () => LISTING);
    await sandbox.stats('one');
    clock.advance(SAMPLE_MS - 1);
    await sandbox.stats('two');
    expect(calls).toHaveLength(1);
    clock.advance(1);
    await sandbox.stats('three');
    expect(calls).toHaveLength(2);
  });
});
