import { RunStop } from './run-stop';

describe('RunStop', () => {
  it('tells its listeners the key of a run it halts', () => {
    const runStop = new RunStop();
    const told: string[] = [];
    runStop.onHalted((key) => told.push(key));
    runStop.halt('r1');
    expect(told).toEqual(['r1']);
    expect(runStop.halted('r1')).toBe(true);
  });
});
