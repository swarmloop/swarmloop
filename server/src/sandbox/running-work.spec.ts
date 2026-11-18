import { RunningWork } from './running-work';

describe('RunningWork', () => {
  it('counts each kind and sums the last samples', () => {
    const work = new RunningWork();
    work.start('a', 'agent');
    work.start('c1', 'check');
    work.start('c2', 'check');
    work.start('s', 'setup');
    work.sample('a', { cpuPercent: 10, rssBytes: 100 });
    work.sample('a', { cpuPercent: 40, rssBytes: 200 });
    work.sample('c1', { cpuPercent: 20, rssBytes: 50 });
    work.sample('s', { cpuPercent: 5, rssBytes: 5 });
    expect(work.load()).toEqual({ agents: 1, checks: 2, setups: 1, cpuPercent: 65, memoryBytes: 255 });
  });

  it('drops an ended container and ignores a sample for an unknown name', () => {
    const work = new RunningWork();
    work.start('a', 'agent');
    work.sample('a', { cpuPercent: 10, rssBytes: 100 });
    work.end('a');
    work.sample('a', { cpuPercent: 90, rssBytes: 900 });
    work.sample('other', { cpuPercent: 90, rssBytes: 900 });
    expect(work.load()).toEqual({ agents: 0, checks: 0, setups: 0, cpuPercent: 0, memoryBytes: 0 });
  });
});
