import { readFileSync } from 'fs';
import { join } from 'path';
import type { SettingSource } from '../contract/settings';
import { envSchema } from './env.schema';
import { resolveRepoRoot } from './repo-root';

interface LoadedSettings {
  readonly values: Readonly<Record<string, string>>;
  readonly sources: Readonly<Record<string, SettingSource>>;
}

const appliedValues = new WeakMap<NodeJS.ProcessEnv, Map<string, Set<string>>>();

/** What the process holds now, except a value this module applied from a file, even when something restored it later. */
function launchEnvironment(target: NodeJS.ProcessEnv = process.env): Readonly<NodeJS.ProcessEnv> {
  const applied = appliedValues.get(target);
  return Object.freeze(
    Object.fromEntries(
      Object.entries(target).filter(([key, value]) => value !== undefined && !applied?.get(key)?.has(value)),
    ),
  );
}

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

function readOptionalFile(path: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export function readDefaultSettings(): Record<string, string> {
  return parseEnvFile(readFileSync(join(resolveRepoRoot(undefined, __dirname), 'defaults.env'), 'utf8'));
}

export function envFilePath(root: string, launchEnv: Readonly<NodeJS.ProcessEnv> = launchEnvironment()): string {
  return launchEnv.SWARMLOOP_ENV_FILE || join(root, '.env');
}

export function readSettings(
  path?: string,
  launchEnv: Readonly<NodeJS.ProcessEnv> = launchEnvironment(),
): LoadedSettings {
  const values: Record<string, string> = {};
  const sources: Record<string, SettingSource> = {};
  const selectedFile = path ?? envFilePath(resolveRepoRoot(undefined, __dirname), launchEnv);
  const layers: [Readonly<NodeJS.ProcessEnv>, SettingSource][] = [
    [readDefaultSettings(), 'default'],
    [readOptionalFile(selectedFile), '.env'],
    [launchEnv, 'environment'],
  ];
  for (const [layer, source] of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) continue;
      values[key] = value;
      sources[key] = source;
    }
  }
  return Object.freeze({ values: Object.freeze(values), sources: Object.freeze(sources) });
}

/**
 * Replace the file values applied earlier, including compatibility keys, and leave every other key as the process has
 * it. An empty default stays unset, since a tool such as git reads an empty variable as a value.
 */
export function applySettings(settings: LoadedSettings, target: NodeJS.ProcessEnv = process.env): void {
  const applied = appliedValues.get(target) ?? new Map<string, Set<string>>();
  for (const [key, values] of applied) {
    const current = target[key];
    if (current !== undefined && values.has(current)) delete target[key];
  }
  for (const [key, value] of Object.entries(settings.values)) {
    if (target[key] !== undefined || (settings.sources[key] === 'default' && value === '')) continue;
    target[key] = value;
    applied.set(key, (applied.get(key) ?? new Set()).add(value));
  }
  appliedValues.set(target, applied);
}

export function assertSettings(settings: LoadedSettings): string | null {
  const { error } = envSchema.validate(settings.values, { abortEarly: false, allowUnknown: true, convert: true });
  return error ? error.message : null;
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
