import { execFileSync } from 'child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/** The one file of the shared test helpers that runs git: it owns the real git calls of test setup. */
export function gitOutput(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function git(cwd: string, args: string[]): string {
  return gitOutput(cwd, args).trim();
}

/** A named pipe at `path`: a file a read would wait on forever. */
export function makeFifo(path: string): void {
  execFileSync('mkfifo', [path]);
}

/** What a template's commits are made in: a new clone of `name` on `branch`, with an empty bare origin already added. */
interface TemplateRepo {
  clone: string;
  remote: string;
  name: string;
  branch: string;
}

const copiers: Map<string, string>[] = [];
let templateFolder: string | undefined;

afterAll(() => {
  if (templateFolder) rmSync(templateFolder, { recursive: true, force: true });
  templateFolder = undefined;
  for (const built of copiers) built.clear();
});

function buildTemplate(name: string, branch: string, commits: (repo: TemplateRepo) => void): string {
  templateFolder ??= mkdtempSync(join(tmpdir(), 'swarmloop-git-fixture-'));
  const base = mkdtempSync(join(templateFolder, `${name}-`));
  const clone = join(base, name);
  const remote = join(base, `${name}.git`);
  git(base, ['init', '-b', branch, clone]);
  git(base, ['init', '--bare', remote]);
  git(clone, ['remote', 'add', 'origin', remote]);
  commits({ clone, remote, name, branch });
  git(clone, ['push', '-u', 'origin', branch]);
  return base;
}

/**
 * A function that copies a repository and its bare origin under a test's root. `commits` makes what the repository
 * starts with; the template is built by it once per spec file for each name and branch, and the branch is pushed after
 * it. In the copy, origin points at the copied bare repository.
 */
export function repoTemplate(
  commits: (repo: TemplateRepo) => void,
): (root: string, name: string, branch?: string) => { clone: string; remote: string } {
  const built = new Map<string, string>();
  copiers.push(built);
  return (root, name, branch = 'main') => {
    const id = `${name}\0${branch}`;
    let base = built.get(id);
    if (base === undefined) {
      base = buildTemplate(name, branch, commits);
      built.set(id, base);
    }
    const clone = join(root, name);
    const remote = join(root, `${name}.git`);
    mkdirSync(root, { recursive: true });
    cpSync(join(base, name), clone, { recursive: true });
    cpSync(join(base, `${name}.git`), remote, { recursive: true });
    git(clone, ['remote', 'set-url', 'origin', remote]);
    return { clone, remote };
  };
}

/** A copy of the main clone and its bare origin under `root`, with origin pointing at the copied bare repository. */
export const copyMainWithOrigin = repoTemplate(({ clone }) => {
  git(clone, ['config', 'user.email', 'dev@example.com']);
  git(clone, ['config', 'user.name', 'Dev']);
  mkdirSync(join(clone, 'src'), { recursive: true });
  writeFileSync(join(clone, 'src', 'readme.ts'), 'export const readme = 1;\n');
  git(clone, ['add', 'src/readme.ts']);
  git(clone, ['commit', '-m', 'init']);
  git(clone, ['switch', '-c', 'holder']);
});
