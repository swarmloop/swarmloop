import { hostOf } from './hosts';

export type ProblemCode = 'refused' | 'expired' | 'host';

export interface LoginProblem {
  code: ProblemCode;
  host: string;
  account: string;
  reason: string;
}

const CODES: readonly string[] = ['refused', 'expired', 'host'];

const REASON_LINES: Record<string, string> = {
  'not listed in SWARMLOOP_ALLOW': 'Ask whoever runs this server to add you.',
  "can't push to any repository this server works on":
    'You need push access to one of the repositories this server works on. Ask whoever runs it.',
};

/** The problem a login came back with, from the query of the page, or null when there is none. */
export function problemFrom(search: string): LoginProblem | null {
  const query = new URLSearchParams(search);
  const code = query.get('error');
  if (code === null || !CODES.includes(code)) {
    return null;
  }
  return {
    code: code as ProblemCode,
    host: query.get('host') ?? '',
    account: query.get('account') ?? '',
    reason: query.get('reason') ?? '',
  };
}

/** The one table of texts: what the alert says for each code. */
export const PROBLEM_TEXTS: Record<ProblemCode, (problem: LoginProblem) => string[]> = {
  refused: (problem) => {
    const lines = [`${problem.account || 'This account'} can't log in to this server`];
    if (problem.reason) {
      lines.push(REASON_LINES[problem.reason] ?? problem.reason);
    }
    return lines;
  },
  expired: () => ['The login took too long or started somewhere else. Try again.'],
  host: (problem) => [`${hostOf(problem.host).label} did not answer: ${problem.reason}`],
};
