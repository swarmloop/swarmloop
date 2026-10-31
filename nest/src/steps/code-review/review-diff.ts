import { chmodSync, mkdirSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { sessionHome } from '../../limits/session-group';
import { agentStateDir, SandboxMount } from '../../sandbox/sandbox-launch';
import { SwarmloopError } from '../../swarmloop-error';
import { isDenied } from '../commit/commit-paths';
import { gitMissing, gitRaw } from '../../git/git';

export const REVIEW_DIFF_PATH = '/work/brief/diff.md';

/** The change reviewers read. Git stays outside the sandbox, which cannot write a read-only checkout. */
export async function reviewDiffSection(
  mounts: SandboxMount[],
  denied: string[] = [],
): Promise<{ heading: string; body: string; patch: string }> {
  const listed: string[] = [];
  const patches: string[] = [];
  for (const mount of mounts) {
    const part = await one(mount, denied);
    listed.push(part.list);
    patches.push(part.patch);
  }
  return {
    heading: 'Diff',
    body: [preamble(), ...listed].join('\n\n'),
    patch: `${patches.join('\n\n')}\n`,
  };
}

const REVIEW_HOMES = [
  'code-review-requirements',
  'code-review-quality',
  'code-review-regressions',
  'code-review-security',
  'code-review-performance',
  'code-review-report',
];

export function writeReviewDiff(root: string, key: string, patch: string): string {
  let written = '';
  for (const home of REVIEW_HOMES) {
    const dir = join(agentStateDir(root, key, sessionHome(home)), 'briefs');
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    const file = join(dir, 'diff.md');
    writeFileSync(file, patch);
    chmodSync(file, 0o644);
    if (!written) {
      written = file;
    }
  }
  return written;
}

function preamble(): string {
  return [
    `The complete diff is ${REVIEW_DIFF_PATH}. Read that file. It is the whole change, including tests.`,
    'Then read the changed files and the code they call in the working directory.',
    'Do not run git. Do not open .git. Do not run tests, a service, a database, or the application.',
  ].join(' ');
}

async function one(mount: SandboxMount, denied: string[]): Promise<{ list: string; patch: string }> {
  const name = repoName(mount);
  if (!(await inside(mount.hostPath))) {
    const text = `## ${name}\n\nNot a git checkout. Read the source files in the working directory.`;
    return { list: text, patch: text };
  }
  const untracked = splitLines(await optional(mount.hostPath, ['ls-files', '--others', '--exclude-standard']));
  const dirtyNames = splitLines(await optional(mount.hostPath, ['diff', '--name-only', 'HEAD']));
  const allowedUntracked = untracked.filter((path) => !isDenied(path, denied));
  const allowedDirty = dirtyNames.filter((path) => !isDenied(path, denied));
  if (allowedDirty.length > 0 || allowedUntracked.length > 0) {
    const dirty = allowedDirty.length > 0 ? withoutDenied(await optional(mount.hostPath, ['diff', 'HEAD']), denied) : '';
    const names = [...allowedDirty, ...allowedUntracked];
    const extra = await untrackedBodies(mount.hostPath, allowedUntracked);
    const status = 'Uncommitted changes against HEAD.';
    return {
      list: block(name, status, fileList(names)),
      patch: block(name, status, [dirty?.trimEnd() ?? '', extra].filter((part) => part.length > 0).join('\n\n')),
    };
  }
  const base = await baseRef(mount.hostPath);
  if (!base) {
    const text = `## ${name}\n\nThe worktree is clean and neither origin/main nor origin/master exists.`;
    return { list: text, patch: text };
  }
  const log = (await optional(mount.hostPath, ['log', '--oneline', `${base}...HEAD`])) ?? '';
  const names = splitLines(await optional(mount.hostPath, ['diff', '--name-only', `${base}...HEAD`]));
  const committed = (await optional(mount.hostPath, ['diff', `${base}...HEAD`])) ?? '';
  const status = `Clean worktree. Commits on HEAD that are not in ${base}.`;
  return {
    list: block(name, status, fileList(names)),
    patch: block(name, status, [log.trim(), committed.trimEnd()].filter((part) => part.length > 0).join('\n\n')),
  };
}

function withoutDenied(patch: string | null, denied: string[]): string {
  const text = patch ?? '';
  if (!text.trim() || denied.length === 0) {
    return text;
  }
  return text
    .split(/^(?=diff --git )/m)
    .filter((part) => {
      const header = part.split('\n', 1)[0] ?? '';
      if (!header.startsWith('diff --git ')) {
        return true;
      }
      const paths = headerPaths(header);
      return paths.length > 0 && paths.every((path) => !isDenied(path, denied));
    })
    .join('')
    .trimEnd();
}

function headerPaths(header: string): string[] {
  const rest = header.slice('diff --git '.length);
  const paths: string[] = [];
  let index = 0;
  for (let count = 0; count < 2; count += 1) {
    while (rest[index] === ' ') {
      index += 1;
    }
    const token = gitToken(rest, index);
    if (!token) {
      return [];
    }
    paths.push(token.value.startsWith('a/') || token.value.startsWith('b/') ? token.value.slice(2) : token.value);
    index = token.next;
  }
  return paths;
}

function gitToken(text: string, start: number): { value: string; next: number } | null {
  if (start >= text.length) {
    return null;
  }
  if (text[start] !== '"') {
    const space = text.indexOf(' ', start);
    const end = space === -1 ? text.length : space;
    return { value: text.slice(start, end), next: end };
  }
  let value = '';
  let index = start + 1;
  while (index < text.length) {
    const char = text[index] ?? '';
    if (char === '"') {
      return { value, next: index + 1 };
    }
    if (char === '\\' && index + 1 < text.length) {
      const next = text[index + 1] ?? '';
      if (next === 'n') {
        value += '\n';
      } else if (next === 't') {
        value += '\t';
      } else if (next === '\\' || next === '"') {
        value += next;
      } else {
        value += next;
      }
      index += 2;
      continue;
    }
    value += char;
    index += 1;
  }
  return null;
}

function block(name: string, status: string, rest: string): string {
  return [`## ${name}`, '', status, '', rest].filter((part) => part.length > 0).join('\n');
}

function fileList(names: string[]): string {
  const unique = [...new Set(names.filter((name) => name.length > 0))];
  if (unique.length === 0) {
    return 'Changed files:\n(none)';
  }
  return `Changed files:\n${unique.join('\n')}`;
}

function splitLines(text: string | null): string[] {
  return (text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes('..'));
}

function repoName(mount: SandboxMount): string {
  if (mount.containerPath.startsWith('/work/')) {
    return mount.containerPath.slice('/work/'.length);
  }
  return basename(mount.hostPath);
}

async function inside(cwd: string): Promise<boolean> {
  try {
    return (await gitRaw(['-C', cwd, 'rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

async function baseRef(cwd: string): Promise<string | null> {
  if (await hasRef(cwd, 'origin/main')) {
    return 'origin/main';
  }
  if (await hasRef(cwd, 'origin/master')) {
    return 'origin/master';
  }
  return null;
}

async function hasRef(cwd: string, ref: string): Promise<boolean> {
  try {
    return (await gitRaw(['-C', cwd, 'rev-parse', '--verify', '--quiet', ref])).trim().length > 0;
  } catch {
    return false;
  }
}

async function untrackedBodies(cwd: string, paths: string[]): Promise<string> {
  const blocks: string[] = [];
  for (const file of paths) {
    const body = await optional(cwd, ['diff', '--no-index', '--', '/dev/null', file]);
    if (body?.trim()) {
      blocks.push(body.trimEnd());
    }
  }
  return blocks.join('\n\n');
}

async function optional(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await gitRaw(['-C', cwd, ...args]);
  } catch (error) {
    if (isOutputCap(error)) {
      throw new SwarmloopError('git diff is too large to read');
    }
    const stdout = stdoutOf(error);
    if (gitMissing(error) && stdout.length > 0) {
      return stdout;
    }
    return null;
  }
}

function isOutputCap(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
}

function stdoutOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'stdout' in error && typeof error.stdout === 'string') {
    return error.stdout;
  }
  return '';
}
