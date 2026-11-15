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

const templates = new Map<string, string>();
let templateFolder: string | undefined;

afterAll(() => {
  if (templateFolder) rmSync(templateFolder, { recursive: true, force: true });
  templateFolder = undefined;
  templates.clear();
});

function buildTemplate(repo: string): string {
  templateFolder ??= mkdtempSync(join(tmpdir(), 'swarmloop-git-fixture-'));
  const base = join(templateFolder, repo);
  mkdirSync(base, { recursive: true });
  const clone = join(base, repo);
  const remote = join(base, `${repo}.git`);
  git(base, ['init', '-b', 'main', clone]);
  git(clone, ['config', 'user.email', 'dev@example.com']);
  git(clone, ['config', 'user.name', 'Dev']);
  mkdirSync(join(clone, 'src'), { recursive: true });
  writeFileSync(join(clone, 'src', 'readme.ts'), 'export const readme = 1;\n');
  git(clone, ['add', 'src/readme.ts']);
  git(clone, ['commit', '-m', 'init']);
  git(base, ['init', '--bare', remote]);
  git(clone, ['remote', 'add', 'origin', remote]);
  git(clone, ['push', '-u', 'origin', 'main']);
  git(clone, ['switch', '-c', 'holder']);
  return base;
}

/** A copy of the main clone and its bare origin under `root`, with origin pointing at the copied bare repository. */
export function copyMainWithOrigin(root: string, repo: string): { clone: string; remote: string } {
  let base = templates.get(repo);
  if (base === undefined) {
    base = buildTemplate(repo);
    templates.set(repo, base);
  }
  const clone = join(root, repo);
  const remote = join(root, `${repo}.git`);
  cpSync(join(base, repo), clone, { recursive: true });
  cpSync(join(base, `${repo}.git`), remote, { recursive: true });
  git(clone, ['remote', 'set-url', 'origin', remote]);
  return { clone, remote };
}
