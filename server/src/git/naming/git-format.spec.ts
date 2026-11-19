import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readGitFormat } from './git-format';

const trees: string[] = [];

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-format-'));
  trees.push(dir);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

afterAll(() => trees.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const NONE = { branch: null, commit: null, title: null, target: null };
const CONVENTIONAL = '{type}[({scope})]: {subject}';

describe('readGitFormat', () => {
  it('is the built-in format for a tree with nothing of its own', () => {
    expect(readGitFormat(tree({ 'package.json': '{"name":"swarm-api","engines":{"node":"22"}}' }))).toEqual(NONE);
  });

  it('reads Conventional Commits from a commitlint config', () => {
    expect(readGitFormat(tree({ 'commitlint.config.js': 'module.exports = {}' }))).toEqual({
      ...NONE,
      commit: CONVENTIONAL,
      title: CONVENTIONAL,
    });
  });

  it('detects commitizen in package.json', () => {
    const body = JSON.stringify({ config: { commitizen: { path: 'cz-conventional-changelog' } } });
    expect(readGitFormat(tree({ 'package.json': body })).commit).toBe(CONVENTIONAL);
  });

  it('lets the manifest beat commitlint, per key', () => {
    const manifest = JSON.stringify({ version: 1, git: { commit: '[{ticket} ]{subject}', target: 'develop' } });
    expect(readGitFormat(tree({ '.swarmloop.json': manifest, '.commitlintrc.json': '{}' }))).toEqual({
      branch: null,
      commit: '[{ticket} ]{subject}',
      title: CONVENTIONAL,
      target: 'develop',
    });
  });
});
