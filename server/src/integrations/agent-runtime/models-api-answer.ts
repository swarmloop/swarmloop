import type { ConnectionTestResult } from '../connection';

/** What a models endpoint answered to a key: a 2xx is ok; else the provider's own error text, or its status. */
export function modelsApiAnswer(provider: string, answer: { status: number; body: string }): ConnectionTestResult {
  if (answer.status >= 200 && answer.status < 300) {
    return { ok: true, account: null };
  }
  return { ok: false, message: providerMessage(answer.body) ?? `${provider} answered ${answer.status}` };
}

function providerMessage(body: string): string | null {
  try {
    const message = (JSON.parse(body) as { error?: { message?: unknown } } | null)?.error?.message;
    return typeof message === 'string' && message !== '' ? message : null;
  } catch {
    return null;
  }
}
