import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { fromSwarmloop, SWARMLOOP_FILE } from '../../environment/environment-config';

/** Conventional Commits, the format that commitlint and commitizen enforce. */
const CONVENTIONAL = '{type}[({scope})]: {subject}';

/** The files of the two tools that name Conventional Commits. Nothing else is read as a sign of a format. */
const COMMITLINT_FILES = [
  ...['', '.json', '.yaml', '.yml', '.js', '.cjs', '.mjs', '.ts', '.cts'].map((end) => `.commitlintrc${end}`),
  ...['js', 'cjs', 'mjs', 'ts', 'cts'].map((end) => `commitlint.config.${end}`),
];
const COMMITIZEN_FILES = ['.czrc', '.cz.json', '.cz.yaml', '.cz.yml', 'cz.config.js', 'cz.config.cjs'];

/** The format of each name of a repository; a null is the built-in format. */
export interface GitFormat {
  branch: string | null;
  commit: string | null;
  title: string | null;
  /** The branch merge requests aim at, or null when the manifest names none. */
  target: string | null;
}

function readText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function hasToolKeyInPackage(tree: string): boolean {
  const text = readText(join(tree, 'package.json'));
  if (!text) {
    return false;
  }
  try {
    const manifest = JSON.parse(text) as { commitlint?: unknown; config?: { commitizen?: unknown } };
    return manifest.commitlint !== undefined || manifest.config?.commitizen !== undefined;
  } catch {
    return false;
  }
}

function hasConventionalTool(tree: string): boolean {
  return (
    [...COMMITLINT_FILES, ...COMMITIZEN_FILES].some((name) => existsSync(join(tree, name))) || hasToolKeyInPackage(tree)
  );
}

/** The format of a working tree, strongest first, key by key: the manifest, then the tools' own config, then the built-in one. */
export function readGitFormat(tree: string): GitFormat {
  const text = readText(join(tree, SWARMLOOP_FILE));
  const manifest = text ? (fromSwarmloop(text).git ?? {}) : {};
  const conventional = hasConventionalTool(tree) ? CONVENTIONAL : null;
  return {
    branch: manifest.branch ?? null,
    commit: manifest.commit ?? conventional,
    title: manifest.title ?? conventional,
    target: manifest.target ?? null,
  };
}
