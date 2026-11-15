import { codeHostAdapters } from '../integrations/code-host/code-host-adapters';
import { knownSecrets } from '../core/secret-sources';

const MASK = '***';
const MIN_SECRET_LENGTH = 4;

const PATTERNS: [RegExp, string][] = [
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/]+@/gi, `$1${MASK}@`],
  [/\b(sk-|xox[abp]-)[A-Za-z0-9_-]+/g, MASK],
  [/\bBearer\s+[^\s"']+/gi, `Bearer ${MASK}`],
  [/(\bAuthorization:[ \t]*)[^\r\n]*/gi, `$1${MASK}`],
];

function tokenPrefixPattern(): RegExp | undefined {
  const prefixes = codeHostAdapters().flatMap((adapter) => adapter.tokenPrefixes);
  if (prefixes.length === 0) {
    return undefined;
  }
  const escaped = prefixes.map((prefix) => prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b(${escaped.join('|')})[A-Za-z0-9_-]+`, 'g');
}

function secretsOf(extra: object): string[] {
  const given = Object.values(extra).filter(
    (value): value is string => typeof value === 'string' && value.length >= MIN_SECRET_LENGTH,
  );
  const plain = [...knownSecrets(), ...given];
  const all = plain.flatMap((secret) => [secret, encodeURIComponent(secret)]);
  return [...new Set(all)].sort((a, b) => b.length - a.length);
}

/** Masks tokens, credentials in URLs, the token prefixes of the code hosts, the secrets that remembered and registered owners list, and every string value of `extra`, before a message is stored or streamed. */
export function redact(text: string, extra: object = {}): string {
  const prefixed = tokenPrefixPattern();
  let masked = PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
  if (prefixed) {
    masked = masked.replace(prefixed, MASK);
  }
  for (const secret of secretsOf(extra)) {
    masked = masked.split(secret).join(MASK);
  }
  return masked;
}
