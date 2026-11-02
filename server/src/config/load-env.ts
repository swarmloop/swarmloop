import { existsSync, readFileSync } from 'fs';
import { envSchema } from './env.schema';

export function loadEnvFile(path: string): void {
  if (!existsSync(path)) {
    return;
  }
  const lines = readFileSync(path, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    process.env[key] = unquote(trimmed.slice(separator + 1).trim());
  }
}

export function assertEnvFile(path: string): string | null {
  loadEnvFile(path);
  const { error } = envSchema.validate(process.env, {
    abortEarly: false,
    allowUnknown: true,
    convert: true,
  });
  return error ? error.message : null;
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
