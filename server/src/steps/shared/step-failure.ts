import { randomBytes } from 'crypto';
import { Logger } from '@nestjs/common';
import { ERROR_CODES } from '../../contract/error-codes';
import type { StepFailure } from '../contract/step-contract';
import { redact } from '../../core/redact';
import { SwarmloopError } from '../../core/swarmloop-error';
import { ResultInvalid } from './answer-errors';

/** `E-` plus 8 base36 characters. */
export function newErrorId(): string {
  const chars = Array.from(randomBytes(8), (byte) => (byte % 36).toString(36));
  return `E-${chars.join('')}`;
}

/**
 * The failure of a step. A `SwarmloopError` keeps its text; any other error shows its redacted first line, or `cause`
 * when the caller knows a better one, and an id.
 */
export function describeFailure(step: string, error: unknown, env?: object, cause?: string): StepFailure {
  const errorId = newErrorId();
  if (error instanceof SwarmloopError) {
    const answerErrors = error instanceof ResultInvalid ? { answerErrors: error.errors } : {};
    return { errorId, code: error.code, category: error.category, message: error.message, ...answerErrors };
  }
  const raw = cause ?? (error instanceof Error ? error.message : String(error));
  const line = redact(raw.split('\n')[0].trim(), env);
  return {
    errorId,
    code: ERROR_CODES.STEP_FAILED,
    category: 'internal',
    message: line === '' ? `${step} failed (${errorId})` : `${step} failed: ${line} (${errorId})`,
  };
}

/** The redacted stack of an error, or its message when it has none, for the server log. */
export function failureStack(error: unknown, env?: object): string {
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
  return redact(text, env);
}

/** Describes a failure and writes its id with the redacted stack to the server log, so the text and the log match. */
export function reportFailure(step: string, error: unknown, env?: object, cause?: string): StepFailure {
  const failure = describeFailure(step, error, env, cause);
  const detail = error instanceof SwarmloopError ? `code ${failure.code}` : `\n${failureStack(error, env)}`;
  new Logger(step).error(`${failure.errorId} ${step} failed: ${detail}`);
  return failure;
}
