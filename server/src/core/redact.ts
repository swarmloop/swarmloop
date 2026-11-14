const MASK = '***';
const SECRET_KEY = /TOKEN|SECRET|KEY|PASSWORD/;
const MIN_SECRET_LENGTH = 4;

const PATTERNS: [RegExp, string][] = [
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/]+@/gi, `$1${MASK}@`],
  [/\b(ghp_|github_pat_|glpat-|sk-|xox[abp]-)[A-Za-z0-9_-]+/g, MASK],
  [/\bBearer\s+[^\s"']+/gi, `Bearer ${MASK}`],
  [/(\bAuthorization:[ \t]*)[^\r\n]*/gi, `$1${MASK}`],
];

const remembered = new Set<string>();

/** Stored secrets are masked wherever a message is redacted, like the secret env values. */
export function rememberSecret(value: string): void {
  if (value.length >= MIN_SECRET_LENGTH) {
    remembered.add(value);
  }
}

function secretsOf(env: object): string[] {
  const values = Object.entries(env)
    .filter(([name, value]) => SECRET_KEY.test(name) && typeof value === 'string' && value.length >= MIN_SECRET_LENGTH)
    .map(([, value]) => value as string);
  return [...new Set([...values, ...remembered])].sort((a, b) => b.length - a.length);
}

/** Masks tokens, credentials in URLs and the values of secret env keys before a message is stored or streamed. */
export function redact(text: string, env: object = {}): string {
  let masked = PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
  for (const secret of secretsOf(env)) {
    masked = masked.split(secret).join(MASK);
  }
  return masked;
}
