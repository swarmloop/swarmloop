import { LiveHub } from './live.hub';

describe('LiveHub', () => {
  it('tells listeners when a run changes and when its log grows', () => {
    const hub = new LiveHub();
    const keys: string[] = [];
    const logs: string[] = [];
    const stopChanged = hub.onChanged((key) => keys.push(key));
    const stopLog = hub.onLog((entry) => logs.push(entry.body));

    hub.changed('run-1');
    hub.log({ key: 'run-1', step: 'research', body: 'hello\n' });
    stopChanged();
    stopLog();
    hub.changed('run-2');
    hub.log({ key: 'run-1', step: 'research', body: 'again\n' });

    expect(keys).toEqual(['run-1']);
    expect(logs).toEqual(['hello\n']);
  });

  it('sums parallel reviewer spend and drops a finished one', () => {
    const hub = new LiveHub();
    hub.log({ key: 'run-1', step: 'code-review-quality', body: 'q\n', usage: { tokensIn: 10, tokensOut: 1, usd: 2 } });
    hub.log({ key: 'run-1', step: 'code-review-security', body: 's\n', usage: { tokensIn: 4, tokensOut: 2, usd: 1 } });
    expect(hub.spendOf('run-1')).toEqual({ tokensIn: 14, tokensOut: 3, usd: 3 });
    hub.dropSpend('run-1', 'code-review-quality');
    expect(hub.spendOf('run-1')).toEqual({ tokensIn: 4, tokensOut: 2, usd: 1 });
  });

  it('keeps each step samples and notifies only when the session peak rises', () => {
    const hub = new LiveHub();
    const spent: string[] = [];
    hub.onSpend((key) => spent.push(key));
    hub.log({ key: 'run-1', step: 'code-review-quality', body: 'q\n', samples: [{ at: 't', cpu: 10, memory: 50 }] });
    hub.log({ key: 'run-1', step: 'code-review-security', body: 's\n', samples: [{ at: 't', cpu: 40, memory: 5 }] });
    expect(hub.peaksOf('run-1')).toEqual({ cpuPeak: 40, memPeak: 50 });
    expect(spent).toEqual(['run-1', 'run-1']);
    hub.log({ key: 'run-1', step: 'code-review-security', body: 's\n', samples: [{ at: 't', cpu: 1, memory: 1 }] });
    expect(hub.peaksOf('run-1')).toEqual({ cpuPeak: 10, memPeak: 50 });
    expect(spent).toEqual(['run-1', 'run-1']);
    hub.dropSpend('run-1', 'code-review-quality');
    expect(hub.peaksOf('run-1')).toEqual({ cpuPeak: 10, memPeak: 50 });
    hub.clearSpend('run-1');
    expect(hub.peaksOf('run-1')).toEqual({ cpuPeak: 0, memPeak: 0 });
  });
});
