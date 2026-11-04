import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

export function runGit(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    encoding: 'utf8',
  });
}

export function writeFiles(repo: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, name)), { recursive: true });
    writeFileSync(join(repo, name), text);
  }
}

/** A temporary repository on branch main with one commit holding the files. */
export function makeRepo(files: Record<string, string> = { 'README.md': 'x\n' }): string {
  const repo = mkdtempSync(join(tmpdir(), 'swarmloop-verify-'));
  runGit(repo, ['init', '-q', '-b', 'main']);
  commitFiles(repo, files);
  return repo;
}

export function commitFiles(repo: string, files: Record<string, string>): void {
  writeFiles(repo, files);
  runGit(repo, ['add', '-A']);
  runGit(repo, ['commit', '-q', '-m', 'files']);
}
