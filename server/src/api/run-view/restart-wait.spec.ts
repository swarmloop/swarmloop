import type { FlowView } from '../../contract/api';
import type { RunEntity } from '../../history/run.entity';
import { withRestartWait } from './restart-wait';

const since = '2026-11-14T22:46:00.000Z';
const chip = (name: string, status: string) => ({ name, status, current: false, attempts: 1 });
const phases: FlowView['phases'] = [
  { phase: 'build', steps: [chip('implement', 'running'), chip('checks', 'queued')] },
];

function run(over: Partial<RunEntity>): RunEntity {
  return {
    status: 'running',
    state: 'recovering',
    stateReason: JSON.stringify({ message: since }),
    currentStep: 'implement',
    ...over,
  } as RunEntity;
}

describe('withRestartWait', () => {
  it('marks the current chip as waiting with the start of the wait', () => {
    const [phase] = withRestartWait(phases, run({}));
    expect(phase?.steps).toEqual([{ ...chip('implement', 'waiting'), restartedAt: since }, chip('checks', 'queued')]);
  });

  it('keeps the chips of a run that is not recovering', () => {
    expect(withRestartWait(phases, run({ state: 'working', stateReason: null }))).toBe(phases);
  });

  it('keeps the chips of a run whose reason has no time', () => {
    expect(withRestartWait(phases, run({ stateReason: JSON.stringify({ message: 'docker is silent' }) }))).toBe(phases);
  });

  it('keeps the chips of a run that is not running', () => {
    expect(withRestartWait(phases, run({ status: 'done' }))).toBe(phases);
  });
});
