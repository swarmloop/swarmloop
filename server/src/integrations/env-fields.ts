/** The values env sets for the given names, by name, or null when it sets none: what a connection's server default holds. */
export function envFields(env: object, names: readonly string[]): Record<string, string> | null {
  const values = env as Record<string, unknown>;
  const set = names.filter((name) => typeof values[name] === 'string' && values[name] !== '');
  return set.length > 0 ? Object.fromEntries(set.map((name) => [name, values[name] as string])) : null;
}
