import { BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';

type ProblemCode = 'refused' | 'expired' | 'host';
type ProblemValues = Partial<Record<'host' | 'account' | 'reason', string>>;

/** The page a login problem returns to: the login page, or Connections for a signed-in person replacing the app. */
export type ProblemBase = '/login' | '/connections';

/** A redirect URL that carries only the problem code and plain words for a person, never a code, a state or a token. */
export function problemUrl(base: ProblemBase, code: ProblemCode, values: ProblemValues = {}): string {
  const query = [`error=${code}`];
  for (const key of ['host', 'account', 'reason'] as const) {
    const value = values[key];
    if (value) {
      query.push(`${key}=${encodeURIComponent(value)}`);
    }
  }
  return `${base}?${query.join('&')}`;
}

/** A same-origin path: one leading `/`, no `//`, no backslash. Anything else is `/`. */
export function safeNext(value: unknown): string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')
    ? value
    : '/';
}

/** The redirect for a login that threw: a bad or expired state is `expired`, a host that failed is `host`. Other errors are not a login problem: null. */
export function problemOf(error: unknown, base: ProblemBase, host: string): string | null {
  if (error instanceof BadRequestException || error instanceof NotFoundException) {
    return problemUrl(base, 'expired');
  }
  return error instanceof BadGatewayException ? problemUrl(base, 'host', { host, reason: error.message }) : null;
}
