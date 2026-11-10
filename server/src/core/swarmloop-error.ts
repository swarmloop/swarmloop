import { ERROR_CODES } from '../contract/error-codes';
import type { ErrorCode } from '../contract/error-codes';

export type ErrorCategory = 'user' | 'project' | 'model' | 'environment' | 'provider' | 'internal';

export class SwarmloopError extends Error {
  readonly code: ErrorCode;
  readonly category: ErrorCategory;

  constructor(message: string, options: { code?: ErrorCode; category?: ErrorCategory } = {}) {
    super(message);
    this.code = options.code ?? ERROR_CODES.STEP_FAILED;
    this.category = options.category ?? 'project';
    this.name = 'SwarmloopError';
  }
}

/** A provider's usage limit that left no agent of the role to take over: the run waits until `resumesAt`. */
export class RuntimeLimit extends SwarmloopError {
  constructor(
    message: string,
    readonly runtime: string,
    /** When the run goes on by itself, UTC, ISO 8601. */
    readonly resumesAt: string,
    readonly window?: string,
    /** UTC, ISO 8601. Absent when the provider's text has no time. */
    readonly resetsAt?: string,
  ) {
    super(message, { code: ERROR_CODES.RUNTIME_LIMIT, category: 'provider' });
    this.name = 'RuntimeLimit';
  }
}

export class FetchFailed extends SwarmloopError {
  constructor(
    message: string,
    readonly httpCalls: HttpCallDraft[] = [],
  ) {
    super(message);
    this.name = 'FetchFailed';
  }
}

export class IssueNotFound extends FetchFailed {
  constructor(message: string, httpCalls: HttpCallDraft[] = []) {
    super(message, httpCalls);
    this.name = 'IssueNotFound';
  }
}

export class PasteNeeded extends SwarmloopError {
  constructor(
    readonly url: string,
    readonly httpCalls: HttpCallDraft[] = [],
  ) {
    super(`paste needed for ${url}`);
    this.name = 'PasteNeeded';
  }
}

export interface HttpCallDraft {
  provider: 'jira' | 'confluence' | 'gitlab' | 'github' | 'other';
  method: string;
  url: string;
  statusCode: number | null;
  durationMs: number;
  error: string | null;
}
