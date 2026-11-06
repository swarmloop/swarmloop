import { Logger } from '@nestjs/common';
import { describeFailure, failureStack, newErrorId, reportFailure } from './step-failure';
import { SwarmloopError } from '../../core/swarmloop-error';

const ENV = { GITHUB_TOKEN: 'tok-value-1' };

describe('step failure', () => {
  it('makes error ids of E- and 8 base36 characters, one per call', () => {
    const ids = Array.from({ length: 50 }, newErrorId);
    for (const id of ids) expect(id).toMatch(/^E-[0-9a-z]{8}$/);
    expect(new Set(ids).size).toBe(50);
  });

  it('keeps a SwarmloopError text and defaults its code and category', () => {
    const failure = describeFailure('plan', new SwarmloopError('repos ghp_abc is missing'), ENV);
    expect(failure).toMatchObject({ code: 'STEP_FAILED', category: 'project', message: 'repos ghp_abc is missing' });
  });

  it('takes the code and category of a SwarmloopError', () => {
    const error = new SwarmloopError('x is missing', { code: 'INPUT_MISSING', category: 'user' });
    expect(describeFailure('plan', error)).toMatchObject({ code: 'INPUT_MISSING', category: 'user' });
  });

  it('shows the redacted first line of a plain error with its id', () => {
    const failure = describeFailure('implement', new Error('push failed tok-value-1\nsecond line'), ENV);
    expect(failure.message).toBe(`implement failed: push failed *** (${failure.errorId})`);
    expect(failure).toMatchObject({ code: 'STEP_FAILED', category: 'internal' });
  });

  it('stringifies a value that is not an Error', () => {
    expect(describeFailure('plan', 'oops').message).toMatch(/^plan failed: oops \(E-[0-9a-z]{8}\)$/);
  });

  it('gives no cause for an empty message', () => {
    expect(describeFailure('plan', new Error('')).message).toMatch(/^plan failed \(E-[0-9a-z]{8}\)$/);
  });

  it('redacts the stack, and falls back to the message', () => {
    const error = new Error('bad tok-value-1');
    expect(failureStack(error, ENV)).toContain('bad ***');
    expect(failureStack(error, ENV)).not.toContain('tok-value-1');
    error.stack = undefined;
    expect(failureStack(error, ENV)).toBe('bad ***');
  });

  it('takes the cause the caller names, redacted, over the message', () => {
    const failure = describeFailure('prepare', new Error('Command failed: git'), ENV, 'fatal: tok-value-1 rejected');
    expect(failure.message).toBe(`prepare failed: fatal: *** rejected (${failure.errorId})`);
  });

  it('logs the id of the failure it returns', () => {
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const failure = reportFailure('plan', new Error('boom tok-value-1'), ENV);
      expect(String(logged.mock.calls[0][0])).toContain(`${failure.errorId} plan failed:`);
      expect(String(logged.mock.calls[0][0])).not.toContain('tok-value-1');
    } finally {
      logged.mockRestore();
    }
  });
});
