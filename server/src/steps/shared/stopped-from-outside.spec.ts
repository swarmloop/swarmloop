import type { AgentRunResult } from '../../agent/agent-runner';
import { stoppedFromOutside } from '../../agent/agent-result';
import { AgentStoppedFromOutside } from './stopped-from-outside';
import { isModelOutage } from './model-host-unavailable';

function ended(signal?: string): AgentRunResult {
  return { exitCode: 143, signal, finishedAt: '2026-01-01T00:00:00.000Z' } as AgentRunResult;
}

describe('stoppedFromOutside', () => {
  it.each(['SIGTERM', 'SIGKILL'])('is true for %s', (signal) => {
    expect(stoppedFromOutside(ended(signal))).toBe(true);
  });

  it.each(['SIGSEGV', undefined])('is false for %s', (signal) => {
    expect(stoppedFromOutside(ended(signal))).toBe(false);
  });
});

describe('AgentStoppedFromOutside', () => {
  it('is a wait with its next try, worded for a person', () => {
    const error = new AgentStoppedFromOutside('SIGTERM', ended('SIGTERM'));
    expect(isModelOutage(error)).toBe(true);
    expect(error.message).toContain('stopped from outside by SIGTERM');
    expect(error.retryAt > '2026-01-01T00:00:00.000Z').toBe(true);
  });
});
