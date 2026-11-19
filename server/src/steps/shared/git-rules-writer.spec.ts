import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { copyMainWithOrigin, git } from '../../testing/git-fixture';
import { GitRulesWriter } from './git-rules-writer';

const roots: string[] = [];

function repository(files: Record<string, string> = {}): {
  path: string;
  mounts: { hostPath: string; containerPath: string }[];
} {
  const root = mkdtempSync(join(tmpdir(), 'swarmloop-rules-writer-'));
  roots.push(root);
  const { clone } = copyMainWithOrigin(root, 'demo');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(clone, name, '..'), { recursive: true });
    writeFileSync(join(clone, name), text);
    git(clone, ['add', name]);
  }
  if (Object.keys(files).length) git(clone, ['commit', '-m', 'environment']);
  return { path: clone, mounts: [{ hostPath: clone, containerPath: '/work' }] };
}

const manifest = (path: string): unknown => JSON.parse(readFileSync(join(path, '.swarmloop.json'), 'utf8'));

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('GitRulesWriter', () => {
  it('adds the rules to an existing .swarmloop.json and keeps its other keys', async () => {
    const { path, mounts } = repository({
      '.swarmloop.json': JSON.stringify({ version: 1, image: 'node:22', git: { target: 'develop', commit: 'old' } }),
    });
    const note = await new GitRulesWriter().write(mounts, { commit: '{type}: {subject}', branch: 'work/{slug}' });
    expect(note).toBe('');
    expect(manifest(path)).toEqual({
      version: 1,
      image: 'node:22',
      git: { target: 'develop', commit: '{type}: {subject}', branch: 'work/{slug}' },
    });
  });

  it('creates a manifest with the version and the git section when the repository has no environment file', async () => {
    const { path, mounts } = repository();
    const note = await new GitRulesWriter().write(mounts, { title: '[{ticket} ]{subject}' });
    expect(note).toBe('');
    expect(manifest(path)).toEqual({ version: 1, git: { title: '[{ticket} ]{subject}' } });
  });

  it('writes no file for a devcontainer-only repository and returns the lines to add', async () => {
    const { path, mounts } = repository({ '.devcontainer/devcontainer.json': '{"image":"node:22"}' });
    const note = await new GitRulesWriter().write(mounts, { commit: '{type}: {subject}' });
    expect(() => readFileSync(join(path, '.swarmloop.json'))).toThrow();
    expect(note).toContain('.swarmloop.json');
    expect(note).toContain('"commit": "{type}: {subject}"');
  });

  it('keeps both rules when two writes reach one file together', async () => {
    const { path, mounts } = repository();
    const writer = new GitRulesWriter();
    await Promise.all([writer.write(mounts, { branch: 'a/{slug}' }), writer.write(mounts, { commit: '{subject}' })]);
    expect(manifest(path)).toEqual({ version: 1, git: { branch: 'a/{slug}', commit: '{subject}' } });
  });

  it('writes nothing for missing or empty rules', async () => {
    const { path, mounts } = repository();
    const writer = new GitRulesWriter();
    expect(await writer.write(mounts, undefined)).toBe('');
    expect(await writer.write(mounts, {})).toBe('');
    expect(() => readFileSync(join(path, '.swarmloop.json'))).toThrow();
  });

  it.each([true, false])(
    'refuses a symbolic link in place of the file and writes nothing behind it (target exists: %s)',
    async (exists) => {
      const { path, mounts } = repository();
      const outside = join(path, '..', 'outside.json');
      if (exists) writeFileSync(outside, '{"version":1}\n');
      symlinkSync(outside, join(path, '.swarmloop.json'));
      await expect(new GitRulesWriter().write(mounts, { commit: '{subject}' })).rejects.toThrow('symbolic link');
      expect(exists ? readFileSync(outside, 'utf8') : existsSync(outside)).toBe(exists ? '{"version":1}\n' : false);
    },
  );
});
