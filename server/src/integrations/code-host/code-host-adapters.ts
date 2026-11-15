import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import type { CodeHostEnv } from './abstract-code-host';
import type { CodeHostAdapter } from './code-host-adapter';

let loaded: readonly CodeHostAdapter[] | undefined;

/** The adapters of every host folder next to this file, by name. Found on the first call and kept. */
export function codeHostAdapters(): readonly CodeHostAdapter[] {
  loaded ??= readdirSync(__dirname, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => ['index.ts', 'index.js'].some((file) => existsSync(join(__dirname, entry.name, file))))
    .map((entry) => (require(join(__dirname, entry.name, 'index')) as { adapter: CodeHostAdapter }).adapter)
    .sort((a, b) => a.name.localeCompare(b.name));
  return loaded;
}

/** The adapter of a host name, or undefined for a name no host has. */
export function codeHostAdapter(name: string): CodeHostAdapter | undefined {
  return codeHostAdapters().find((adapter) => adapter.name === name);
}

/** The base URL of a host: the one in the env, else its public site. */
export function codeHostBaseUrl(adapter: CodeHostAdapter, env: CodeHostEnv): URL {
  return new URL(env[adapter.baseKey] || `https://${adapter.publicHost}`);
}
