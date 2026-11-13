import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { git } from '../../testing/runs.spec-helpers';
import { sameOwnDiff } from './own-diff';

const BODY = Array.from({ length: 30 }, (_, line) => `export const line${line} = ${line};`).join('\n');

/** A repository whose `work` branch adds one line to `lines.ts`, cut from `main`. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'swarmloop-own-diff-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'dev@example.com']);
  git(dir, ['config', 'user.name', 'Dev']);
  writeFileSync(join(dir, 'lines.ts'), `${BODY}\n`);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'init']);
  git(dir, ['switch', '-c', 'work']);
  writeFileSync(join(dir, 'lines.ts'), `${BODY.replace('line20 = 20;', 'line20 = 21;')}\n`);
  git(dir, ['commit', '-am', 'work']);
  return dir;
}

/** Moves `main` on by a change in `file`, and rebases `work` onto it. Returns the old head of `work` and the new base. */
function moveBase(dir: string, file: string, text: string): { before: string; base: string } {
  const before = git(dir, ['rev-parse', 'HEAD']);
  git(dir, ['switch', 'main']);
  writeFileSync(join(dir, file), text);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'sibling']);
  const base = git(dir, ['rev-parse', 'HEAD']);
  git(dir, ['switch', 'work']);
  git(dir, ['rebase', 'main']);
  return { before, base };
}

describe('sameOwnDiff', () => {
  it('holds when the base moved in another file', async () => {
    const dir = repo();
    const { before, base } = moveBase(dir, 'other.ts', 'export const other = 1;\n');

    expect(await sameOwnDiff(dir, before, base)).toBe(true);
  });

  it('holds when the base moved far from the change in the same file', async () => {
    const dir = repo();
    const { before, base } = moveBase(dir, 'lines.ts', `${BODY.replace('line2 = 2;', 'line2 = 22;')}\n`);

    expect(await sameOwnDiff(dir, before, base)).toBe(true);
  });

  it('does not hold when the base changed the lines around the change of the branch', async () => {
    const dir = repo();
    const { before, base } = moveBase(dir, 'lines.ts', `${BODY.replace('line18 = 18;', 'line18 = 99;')}\n`);

    expect(await sameOwnDiff(dir, before, base)).toBe(false);
  });
});
