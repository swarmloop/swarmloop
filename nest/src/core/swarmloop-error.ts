export class SwarmloopError extends Error {
  constructor(message: string) {
    super(message);
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
