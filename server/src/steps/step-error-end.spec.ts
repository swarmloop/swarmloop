import { STOP_NOTE } from '../contract/run-state';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import { ChecksStopped } from '../environment/check-pool';
import { errorEnd } from './step-error-end';

describe('errorEnd', () => {
  it('ends a step blocked with the stop note when a Stop took its check commands out of the line', () => {
    const end = errorEnd(new ChecksStopped(), '10:00', new FakeClock(), { RECONCILE_MS: 1000 });
    expect(end).toEqual({ outcome: 'blocked', exitCode: 1, line: `10:00 ${STOP_NOTE}` });
  });
});
