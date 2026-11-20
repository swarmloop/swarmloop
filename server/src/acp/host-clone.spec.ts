import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readHostClone } from './host-clone';

function folder(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'swarmloop-host-clone-')));
}

const config = '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:o/r.git\n\tfetch = +refs/*:refs/*\n';

describe('readHostClone', () => {
  it('gives the top folder and the origin of a path inside a clone', () => {
    const top = folder();
    mkdirSync(join(top, '.git'));
    mkdirSync(join(top, 'src', 'deep'), { recursive: true });
    writeFileSync(join(top, '.git', 'config'), config);
    expect(readHostClone(join(top, 'src', 'deep'))).toEqual({ top, origin: 'git@github.com:o/r.git' });
  });

  it('follows the .git file of a linked worktree through gitdir and commondir', () => {
    const base = folder();
    const main = join(base, 'main', '.git');
    mkdirSync(join(main, 'worktrees', 'w'), { recursive: true });
    writeFileSync(join(main, 'config'), config);
    writeFileSync(join(main, 'worktrees', 'w', 'commondir'), '../..\n');
    const tree = join(base, 'tree');
    mkdirSync(tree);
    writeFileSync(join(tree, '.git'), `gitdir: ${join(main, 'worktrees', 'w')}\n`);
    expect(readHostClone(tree)).toEqual({ top: tree, origin: 'git@github.com:o/r.git' });
  });

  it('gives null without .git or without an origin', () => {
    const plain = folder();
    expect(readHostClone(plain)).toBeNull();
    const top = folder();
    mkdirSync(join(top, '.git'));
    writeFileSync(join(top, '.git', 'config'), '[remote "upstream"]\n\turl = x\n');
    expect(readHostClone(top)).toBeNull();
  });
});
