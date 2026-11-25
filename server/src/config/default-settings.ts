import { readFileSync } from 'fs';
import { join } from 'path';
import { resolveRepoRoot } from './repo-root';

export function parseEnvFile(body: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^(?:export\s+)?([^=\s]+)\s*=(.*)$/.exec(trimmed);
    if (!match) continue;
    values[match[1]] = unquote(match[2].trim());
  }
  return values;
}

/** The text of defaults.env, the one source of the server's default settings and of what each one means. */
export function readDefaultSettingsText(): string {
  return readFileSync(join(resolveRepoRoot(undefined, __dirname), 'defaults.env'), 'utf8');
}

export function readDefaultSettings(): Record<string, string> {
  return parseEnvFile(readDefaultSettingsText());
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
