import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { resolveRepoRoot } from './repo-root';

describe('repository root', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(__dirname, '.root-spec-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('keeps an explicitly configured root', () => {
    expect(resolveRepoRoot(root, __dirname)).toBe(root);
  });

  it('discovers an ancestor with defaults.env beside skills, including an empty configured root', async () => {
    const child = join(root, 'server', 'src', 'config');
    await mkdir(child, { recursive: true });
    await mkdir(join(root, 'skills'));
    await writeFile(join(root, 'defaults.env'), '');
    expect(resolveRepoRoot(undefined, child)).toBe(root);
    expect(resolveRepoRoot('', child)).toBe(root);
  });

  it.each(['defaults.env', 'skills'])('rejects a root missing %s', async (missing) => {
    const child = join(root, ...Array<string>(8).fill('nested'));
    await mkdir(child, { recursive: true });
    if (missing !== 'skills') await mkdir(join(child, 'skills'));
    if (missing !== 'defaults.env') await writeFile(join(child, 'defaults.env'), '');
    expect(() => resolveRepoRoot(undefined, child)).toThrow('repo root is missing');
  });
});
