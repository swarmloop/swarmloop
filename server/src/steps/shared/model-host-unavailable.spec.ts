import { emptyResult } from '../../testing/result-answer';
import { ERROR_CODES } from '../../contract/error-codes';
import { HostUnavailable, isHostOutage } from '../../core/swarmloop-error';
import { HOST_VISIT, ModelHostUnavailable, hostRoute, isModelOutage } from './model-host-unavailable';

const FINISHED = '2026-11-25T10:00:00.000Z';
const error = new ModelHostUnavailable(
  { host: 'api.anthropic.com', detail: 'API error' },
  emptyResult('time', 0, 1, FINISHED),
);

describe('isModelOutage', () => {
  it('is true for a model host outage, which is also a host outage, and false for a code host or a record', () => {
    expect(isModelOutage(error)).toBe(true);
    expect(isHostOutage(error)).toBe(true);
    expect(isModelOutage(new HostUnavailable('github.com', 'timeout', FINISHED))).toBe(false);
    expect(isModelOutage({ code: 'HOST_UNAVAILABLE', message: 'x' })).toBe(false);
  });
});

describe('ModelHostUnavailable', () => {
  it('waits with HOST_UNAVAILABLE and shows the next try, five minutes after the launch ended', () => {
    expect(hostRoute(error)).toEqual({
      to: 'wait',
      reason: 'api.anthropic.com did not answer: API error; next try at 2026-11-25T10:05:00.000Z',
      code: ERROR_CODES.HOST_UNAVAILABLE,
      retryAt: '2026-11-25T10:05:00.000Z',
    });
  });

  it('stores a visit whose model host did not answer as interrupted with HOST_UNAVAILABLE', () => {
    expect(HOST_VISIT).toEqual({ status: 'interrupted', killReason: ERROR_CODES.HOST_UNAVAILABLE });
  });
});
