import { cpSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeRepo } from '../git/git-repo.spec-helpers';

const templates = new Map<string, string>();
const copies: string[] = [];

afterAll(() => {
  for (const repo of [...templates.values(), ...copies]) {
    rmSync(repo, { recursive: true, force: true });
  }
  templates.clear();
  copies.length = 0;
});

export function sharedRepo(files: Record<string, string>): string {
  const key = JSON.stringify(files);
  let repo = templates.get(key);
  if (repo === undefined) {
    repo = makeRepo(files);
    templates.set(key, repo);
  }
  return repo;
}

export function copiedRepo(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), 'swarmloop-project-copy-'));
  copies.push(repo);
  cpSync(sharedRepo(files), repo, { recursive: true });
  return repo;
}
