import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
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
