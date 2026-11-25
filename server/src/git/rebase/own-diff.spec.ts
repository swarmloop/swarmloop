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
function moveBase(dir: string, file: string, text: string): { before: string; base: string; own: string } {
  const before = git(dir, ['rev-parse', 'HEAD']);
  const own = git(dir, ['merge-base', 'main', 'HEAD']);
  git(dir, ['switch', 'main']);
  writeFileSync(join(dir, file), text);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'sibling']);
  const base = git(dir, ['rev-parse', 'HEAD']);
  git(dir, ['switch', 'work']);
  git(dir, ['rebase', 'main']);
  return { before, base, own };
}

describe('sameOwnDiff', () => {
  it('holds when the base moved in another file', async () => {
    const dir = repo();
    const { before, base, own } = moveBase(dir, 'other.ts', 'export const other = 1;\n');

    expect(await sameOwnDiff(dir, own, before, base)).toBe(true);
  });

  it('holds when the base moved far from the change in the same file', async () => {
    const dir = repo();
    const { before, base, own } = moveBase(dir, 'lines.ts', `${BODY.replace('line2 = 2;', 'line2 = 22;')}\n`);

    expect(await sameOwnDiff(dir, own, before, base)).toBe(true);
  });

  it('does not hold when the base changed the lines around the change of the branch', async () => {
    const dir = repo();
    const { before, base, own } = moveBase(dir, 'lines.ts', `${BODY.replace('line18 = 18;', 'line18 = 99;')}\n`);

    expect(await sameOwnDiff(dir, own, before, base)).toBe(false);
  });

  describe('after the base was rewritten', () => {
    /** An epic branch with a commit, a `part` on it with one change, then the epic rewritten onto a moved main. */
    function rewritten(): { dir: string; epicTip: string; before: string; base: string } {
      const dir = repo();
      git(dir, ['switch', 'main']);
      git(dir, ['switch', '-c', 'epic']);
      writeFileSync(join(dir, 'epic.ts'), 'export const epic = 1;\n');
      git(dir, ['add', '.']);
      git(dir, ['commit', '-m', 'epic']);
      const epicTip = git(dir, ['rev-parse', 'HEAD']);
      git(dir, ['switch', '-c', 'part']);
      writeFileSync(join(dir, 'lines.ts'), `${BODY.replace('line20 = 20;', 'line20 = 21;')}\n`);
      git(dir, ['commit', '-am', 'part']);
      const before = git(dir, ['rev-parse', 'HEAD']);
      git(dir, ['switch', 'main']);
      writeFileSync(join(dir, 'other.ts'), 'export const other = 1;\n');
      git(dir, ['add', '.']);
      git(dir, ['commit', '-m', 'moved']);
      git(dir, ['switch', 'epic']);
      git(dir, ['rebase', 'main']);
      return { dir, epicTip, before, base: git(dir, ['rev-parse', 'HEAD']) };
    }

    it('holds when the part carries the change it had', async () => {
      const { dir, epicTip, before, base } = rewritten();
      git(dir, ['switch', 'part']);
      git(dir, ['rebase', '--onto', base, epicTip]);

      expect(await sameOwnDiff(dir, epicTip, before, base)).toBe(true);
    });

    it('does not hold when the part carries another change', async () => {
      const { dir, epicTip, before, base } = rewritten();
      git(dir, ['switch', 'part']);
      git(dir, ['rebase', '--onto', base, epicTip]);
      writeFileSync(join(dir, 'lines.ts'), `${BODY.replace('line20 = 20;', 'line20 = 22;')}\n`);
      git(dir, ['commit', '-am', 'edited']);

      expect(await sameOwnDiff(dir, epicTip, before, base)).toBe(false);
    });
  });
});
