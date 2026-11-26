import { ERROR_CODES } from '../contract/error-codes';
import {
  FetchFailed,
  GitRulesError,
  HostUnavailable,
  RuntimeLimit,
  isHostOutage,
  isUsageLimit,
} from './swarmloop-error';

const host = new HostUnavailable('github.com', 'timeout', '2026-11-26T10:00:00.000Z');
const limit = new RuntimeLimit('limit', 'claude', '2026-11-26T11:00:00.000Z');

describe('GitRulesError', () => {
  it('names the host message and the refused name, and says where the rule goes', () => {
    const error = new GitRulesError('title must start with a ticket', 'feat: add x');
    expect(error.message).toBe('title must start with a ticket refuses feat: add x');
    expect(error.code).toBe(ERROR_CODES.GIT_RULES);
    expect(error.category).toBe('user');
    expect(error.hint).toBe('put the rule into .swarmloop.json');
  });
});

describe('isHostOutage', () => {
  it('is true for a HostUnavailable only', () => {
    expect(isHostOutage(host)).toBe(true);
    expect(isHostOutage(new FetchFailed('x'))).toBe(false);
    expect(isHostOutage(limit)).toBe(false);
    expect(isHostOutage({ code: 'HOST_UNAVAILABLE', message: 'x', retryAt: 't' })).toBe(false);
  });
});

describe('isUsageLimit', () => {
  it('is true for a RuntimeLimit only', () => {
    expect(isUsageLimit(limit)).toBe(true);
    expect(isUsageLimit(host)).toBe(false);
    expect(isUsageLimit({ code: 'RUNTIME_LIMIT', message: 'x', resumesAt: 't' })).toBe(false);
  });
});
