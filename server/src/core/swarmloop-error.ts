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

export class FetchFailed extends SwarmloopError {
  constructor(
    message: string,
    readonly httpCalls: HttpCallDraft[] = [],
  ) {
    super(message);
    this.name = 'FetchFailed';
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
