/** The `message` or `error` text of a host's JSON answer. */
export function providerMessage(body: Buffer): string {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { message?: unknown; error?: unknown } | null;
    const text = parsed?.message ?? parsed?.error;
    return typeof text === 'string' ? text.trim() : '';
  } catch {
    return '';
  }
}

export function configuredHost(base: string): string | null {
  const trimmed = base.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    return null;
  }
}
