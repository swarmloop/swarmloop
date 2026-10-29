import { SwarmloopError } from '../swarmloop-error';

const UNSAFE = /[~^:?*[\\\s]/;

export type PromptBase = { kind: 'named'; name: string } | { kind: 'default' };

/** One `branch:` line in the prompt, or the default main/master base when the line is absent. */
export function promptBase(prompt: string | null | undefined): PromptBase {
  const found: string[] = [];
  for (const match of (prompt ?? '').matchAll(/^[ \t]*branch:[ \t]*(.*)$/gm)) {
    found.push(match[1] ?? '');
  }
  if (found.length === 0) {
    return { kind: 'default' };
  }
  if (found.length > 1) {
    throw new SwarmloopError('branch is ambiguous');
  }
  const name = namedBranch(found[0] ?? '');
  if (!name) {
    throw new SwarmloopError('branch is invalid');
  }
  return { kind: 'named', name };
}

export function originRef(name: string): string {
  return `origin/${name}`;
}

function namedBranch(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) {
    return null;
  }
  const name = trimmed.startsWith('origin/') ? trimmed.slice('origin/'.length) : trimmed;
  if (name.length === 0 || name.startsWith('-') || name.startsWith('/') || name.includes('..') || name.includes('@{')) {
    return null;
  }
  if (UNSAFE.test(name)) {
    return null;
  }
  return name;
}
