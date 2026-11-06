import { randomBytes } from 'crypto';
import { ERROR_CODES } from '../contract/error-codes';
import type { ErrorCode } from '../contract/error-codes';
import { redact } from './redact';
import { SwarmloopError } from './swarmloop-error';
import type { ErrorCategory } from './swarmloop-error';

export interface StepFailure {
  errorId: string;
  code: ErrorCode;
  category: ErrorCategory;
  message: string;
}

/** `E-` plus 8 base36 characters. */
export function newErrorId(): string {
  const chars = Array.from(randomBytes(8), (byte) => (byte % 36).toString(36));
  return `E-${chars.join('')}`;
}

/** The failure of a step. A `SwarmloopError` keeps its text; any other error shows its redacted first line and an id. */
export function describeFailure(step: string, error: unknown, env?: object): StepFailure {
  const errorId = newErrorId();
  if (error instanceof SwarmloopError) {
    return { errorId, code: error.code, category: error.category, message: error.message };
  }
  const raw = error instanceof Error ? error.message : String(error);
  const cause = redact(raw.split('\n')[0].trim(), env);
  return {
    errorId,
    code: ERROR_CODES.STEP_FAILED,
    category: 'internal',
    message: cause === '' ? `${step} failed (${errorId})` : `${step} failed: ${cause} (${errorId})`,
  };
}

/** The redacted stack of an error, or its message when it has none, for the server log. */
export function failureStack(error: unknown, env?: object): string {
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
  return redact(text, env);
}
