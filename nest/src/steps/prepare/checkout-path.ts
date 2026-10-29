import { existsSync, readdirSync, statSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';
import { SwarmloopError } from '../../swarmloop-error';

export const CHECKOUT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function resolveCheckoutPath(repoRoot: string, checkoutsRoot: string | undefined, name: string, storedPath: string): string {
  const stored = storedPath.trim();
  if (stored.length > 0 && isAbsolute(stored)) {
    return stored;
  }
  return resolve(checkoutsRootPath(repoRoot, checkoutsRoot), stored.length > 0 ? stored : name);
}

export function checkoutsRootPath(repoRoot: string, checkoutsRoot: string | undefined): string {
  const configured = checkoutsRoot?.trim() ?? '';
  if (configured.length === 0) {
    throw new SwarmloopError('CHECKOUTS_ROOT is missing');
  }
  return isAbsolute(configured) ? configured : resolve(repoRoot, configured);
}

export function listGitProjects(repoRoot: string, checkoutsRoot: string | undefined): string[] {
  const root = checkoutsRootPath(repoRoot, checkoutsRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new SwarmloopError('CHECKOUTS_ROOT is missing');
  }
  return readdirSync(root).filter((name) => isGitProject(root, name)).sort();
}

export function storedProjects(body: string | null | undefined): string[] {
  if (!body?.trim()) {
    return [];
  }
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => name.length > 0);
}

export function renderProjects(names: string[]): string {
  return `${[...new Set(names)].sort().join('\n')}\n`;
}

function isGitProject(root: string, name: string): boolean {
  if (name.startsWith('.') || name.startsWith('run-') || !CHECKOUT_NAME.test(name)) {
    return false;
  }
  const path = join(root, name);
  try {
    return statSync(path).isDirectory() && existsSync(join(path, '.git'));
  } catch {
    return false;
  }
}
