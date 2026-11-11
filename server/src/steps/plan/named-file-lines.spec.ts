import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { withNamedFileLines } from './named-file-lines';

describe('withNamedFileLines', () => {
  const named = (text: string, mounts: { hostPath: string; containerPath: string }[]) =>
    withNamedFileLines([], text, mounts)[0] ?? null;
  const mount = (hostPath: string) => ({ hostPath, containerPath: '/work' });
  const tree = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'swarmloop-lines-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), 'one\ntwo\nthree\n');
    writeFileSync(join(dir, 'src', 'b.php'), 'one\ntwo');
    writeFileSync(join(dir, 'README.md'), '# title\n');
    return dir;
  };

  it('counts the lines of a named file, with and without a final newline', () => {
    const section = named('change `src/a.ts` and src/b.php.', [mount(tree())]);
    expect(section?.body).toBe('src/a.ts: 3 lines\nsrc/b.php: 2 lines');
  });

  it('counts a non-code file the same way', () => {
    expect(named('see README.md', [mount(tree())])?.body).toBe('README.md: 1 lines');
  });

  it('skips missing files, directories and paths outside the mount', () => {
    const dir = tree();
    expect(named('src/none.ts src ../x /etc/hostname src/../README.md', [mount(dir)])).toBeNull();
  });

  it('returns null when no file is named', () => {
    expect(named('nothing here', [mount(tree())])).toBeNull();
  });

  it('finds a file in the second mount', () => {
    const other = mkdtempSync(join(tmpdir(), 'swarmloop-lines-'));
    expect(named('src/a.ts', [mount(other), mount(tree())])?.body).toBe('src/a.ts: 3 lines');
  });
});
