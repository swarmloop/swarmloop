import { SwarmloopError } from '../core/swarmloop-error';
import { makeRepo, writeFiles } from '../git/git-repo.spec-helpers';
import {
  fromDevcontainer,
  fromSwarmloop,
  lifecycleCommand,
  readEnvironmentConfig,
  stripJsonComments,
} from './environment-config';

describe('fromSwarmloop', () => {
  it('reads the new keys', () => {
    const config = fromSwarmloop(
      JSON.stringify({
        version: 1,
        image: 'node:22',
        setup: 'npm ci',
        checks: ['npm test'],
        cache: ['/home/sandbox/.npm'],
      }),
    );
    expect(config).toEqual({
      source: '.swarmloop.json',
      image: 'node:22',
      setup: 'npm ci',
      cache: ['/home/sandbox/.npm'],
      checks: ['npm test'],
    });
  });

  it('names the new key for a key of the first format', () => {
    expect(() => fromSwarmloop(JSON.stringify({ version: 1, image: 'a', install: 'x', verify: ['y'] }))).toThrow(
      '.swarmloop.json: "install" is now "setup", "verify" is now "checks"',
    );
  });

  it('reads a network kept to the setup', () => {
    expect(fromSwarmloop(JSON.stringify({ version: 1, image: 'a', network: 'setup' })).network).toBe('setup');
    expect(fromSwarmloop(JSON.stringify({ version: 1, image: 'a' })).network).toBeUndefined();
    expect(
      fromDevcontainer(JSON.stringify({ image: 'a', customizations: { swarmloop: { network: 'setup' } } }), 'x.json')
        .network,
    ).toBe('setup');
  });

  it('reads a Dockerfile under .swarmloop with that folder as the build context', () => {
    const config = fromSwarmloop(
      JSON.stringify({ version: 1, dockerfile: '.swarmloop/Dockerfile', setup: 'npm ci', checks: ['lint'] }),
    );
    expect(config).toMatchObject({ dockerfile: '.swarmloop/Dockerfile', context: '.swarmloop', checks: ['lint'] });
  });

  it.each([
    ['neither image nor dockerfile', { version: 1 }],
    ['both', { version: 1, image: 'a', dockerfile: '.swarmloop/D' }],
    ['a dockerfile outside .swarmloop', { version: 1, dockerfile: 'Dockerfile' }],
    ['a cache outside the home', { version: 1, image: 'a', cache: ['/tmp/x'] }],
    ['version 2', { version: 2, image: 'a' }],
    ['an unknown network', { version: 1, image: 'a', network: 'all' }],
    ['the old install key', { version: 1, image: 'a', install: 'npm ci' }],
  ])('rejects %s', (_name, raw) => {
    expect(() => fromSwarmloop(JSON.stringify(raw))).toThrow(SwarmloopError);
  });

  it('rejects text that is not JSON', () => {
    expect(() => fromSwarmloop('{')).toThrow('.swarmloop.json: is not valid JSON');
  });
});

describe('fromDevcontainer', () => {
  const file = '.devcontainer/devcontainer.json';

  it('reads an image, the create commands and the swarmloop customizations', () => {
    const text = `{
      // the base
      "image": "mcr.microsoft.com/devcontainers/php:8.3",
      "onCreateCommand": "composer install",
      "postCreateCommand": ["npm", "ci", "--prefix", "web app"],
      "customizations": { "swarmloop": { "checks": ["composer test"], "cache": ["/home/sandbox/.composer", "/tmp/no"] } },
    }`;
    expect(fromDevcontainer(text, file)).toEqual({
      source: file,
      image: 'mcr.microsoft.com/devcontainers/php:8.3',
      setup: "composer install && npm ci --prefix 'web app'",
      cache: ['/home/sandbox/.composer'],
      checks: ['composer test'],
    });
  });

  it('reads a build with a context outside the folder', () => {
    const text = JSON.stringify({ build: { dockerfile: 'Dockerfile', context: '..' } });
    expect(fromDevcontainer(text, file)).toMatchObject({ dockerfile: '.devcontainer/Dockerfile', context: '.' });
  });

  it('defaults the build context to the folder of the file', () => {
    expect(fromDevcontainer(JSON.stringify({ dockerFile: 'Dockerfile' }), file)).toMatchObject({
      dockerfile: '.devcontainer/Dockerfile',
      context: '.devcontainer',
    });
  });

  it.each([
    ['features', { image: 'a', features: { 'ghcr.io/devcontainers/features/node:1': {} } }],
    ['compose', { dockerComposeFile: 'compose.yml', service: 'app' }],
    ['no image or build', { name: 'x' }],
    ['a context outside the repository', { build: { dockerfile: 'Dockerfile', context: '../..' } }],
  ])('rejects %s with a clear text', (_name, raw) => {
    expect(() => fromDevcontainer(JSON.stringify(raw), file)).toThrow(SwarmloopError);
  });

  it('accepts empty features', () => {
    expect(fromDevcontainer(JSON.stringify({ image: 'a', features: {} }), file).image).toBe('a');
  });
});

describe('lifecycleCommand', () => {
  it('joins named commands', () => {
    expect(lifecycleCommand({ server: 'npm ci --prefix server', web: ['npm', 'ci'] })).toBe(
      '(npm ci --prefix server) && (npm ci)',
    );
    expect(lifecycleCommand(undefined)).toBe('');
  });
});

describe('stripJsonComments', () => {
  it('keeps comment-like text and commas inside strings', () => {
    const text = '{ "a": "http://x/*y*/", /* note */ "b": "1,}", // end\n }';
    expect(JSON.parse(stripJsonComments(text))).toEqual({ a: 'http://x/*y*/', b: '1,}' });
  });

  it('drops a trailing comma that a comment follows', () => {
    expect(JSON.parse(stripJsonComments('{ "a": [1, 2,], "b": 1, // last\n}'))).toEqual({ a: [1, 2], b: 1 });
  });
});

describe('readEnvironmentConfig', () => {
  it('prefers .swarmloop.json, then devcontainer, and reads committed files only', async () => {
    const repo = makeRepo({
      '.devcontainer/devcontainer.json': JSON.stringify({ image: 'from-devcontainer' }),
    });
    expect((await readEnvironmentConfig(repo))?.image).toBe('from-devcontainer');
    writeFiles(repo, { '.swarmloop.json': JSON.stringify({ version: 1, image: 'not-committed' }) });
    expect((await readEnvironmentConfig(repo))?.image).toBe('from-devcontainer');
  });

  it('returns null without either file', async () => {
    expect(await readEnvironmentConfig(makeRepo())).toBeNull();
  });
});
