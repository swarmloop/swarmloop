import { SwarmloopError } from '../core/swarmloop-error';
import { makeRepo, writeFiles } from './git-repo.spec-helpers';
import { isCachePath, readManifest } from './manifest';

function repoWith(manifest: unknown): string {
  return makeRepo({ '.swarmloop.json': typeof manifest === 'string' ? manifest : JSON.stringify(manifest) });
}

const valid = {
  version: 1,
  image: 'node:22-bookworm-slim',
  install: 'npm ci',
  verify: ['npm test'],
  cache: ['/home/sandbox/.npm'],
  timeoutMin: 20,
};

describe('readManifest', () => {
  it('reads a full manifest', async () => {
    const result = await readManifest(repoWith(valid), 'main');
    expect(result).toEqual({ manifest: valid, warnings: [] });
  });

  it('fills the default timeout for a minimal manifest', async () => {
    const result = await readManifest(repoWith({ version: 1, image: 'node:22', verify: ['true'] }), 'main');
    expect(result?.manifest).toEqual({ version: 1, image: 'node:22', verify: ['true'], timeoutMin: 15 });
  });

  it('accepts a dockerfile under .swarmloop/', async () => {
    const result = await readManifest(
      repoWith({ version: 1, dockerfile: '.swarmloop/Dockerfile', verify: ['true'] }),
      'main',
    );
    expect(result?.manifest.dockerfile).toBe('.swarmloop/Dockerfile');
  });

  it('returns null when the base ref has no manifest', async () => {
    expect(await readManifest(makeRepo(), 'main')).toBeNull();
  });

  it('fails on a ref that does not exist', async () => {
    await expect(readManifest(makeRepo(), 'nope')).rejects.toThrow(SwarmloopError);
  });

  it('reads the base ref, not the worktree', async () => {
    const repo = repoWith(valid);
    writeFiles(repo, { '.swarmloop.json': JSON.stringify({ ...valid, verify: ['true'] }) });
    const result = await readManifest(repo, 'main');
    expect(result?.manifest.verify).toEqual(['npm test']);
  });

  it.each([
    ['both image and dockerfile', { ...valid, dockerfile: '.swarmloop/Dockerfile' }, '"value"'],
    ['neither image nor dockerfile', { version: 1, verify: ['true'] }, '"value"'],
    ['an empty verify', { ...valid, verify: [] }, '"verify" must contain at least 1 items'],
    ['a cache path outside /home/sandbox/', { ...valid, cache: ['/root/.npm'] }, '"cache"'],
    ['a cache path that climbs out', { ...valid, cache: ['/home/sandbox/../etc'] }, '"cache"'],
    ['version 2', { ...valid, version: 2 }, '"version" must be [1]'],
    ['a timeout above 60', { ...valid, timeoutMin: 61 }, '"timeoutMin"'],
    ['a dockerfile outside .swarmloop/', { version: 1, dockerfile: 'Dockerfile', verify: ['true'] }, '"dockerfile"'],
    ['a dockerfile that climbs out', { version: 1, dockerfile: '.swarmloop/../x', verify: ['true'] }, '"dockerfile"'],
  ])('rejects %s and names the key', async (_name, manifest, key) => {
    await expect(readManifest(repoWith(manifest), 'main')).rejects.toThrow(key);
  });

  it('rejects text that is not JSON', async () => {
    await expect(readManifest(repoWith('{'), 'main')).rejects.toThrow('.swarmloop.json: is not valid JSON');
  });

  it('ignores an unknown key and reports it as a warning', async () => {
    const result = await readManifest(repoWith({ ...valid, registries: ['x'] }), 'main');
    expect(result?.warnings).toEqual(['unknown key "registries" ignored']);
  });
});

describe('isCachePath', () => {
  it('accepts only normalized paths below /home/sandbox/', () => {
    expect(isCachePath('/home/sandbox/.npm')).toBe(true);
    expect(isCachePath('/home/sandbox')).toBe(false);
    expect(isCachePath('/home/sandbox/')).toBe(false);
    expect(isCachePath('/home/sandbox/a/../b')).toBe(false);
    expect(isCachePath('/home/sandboxer/x')).toBe(false);
  });
});
