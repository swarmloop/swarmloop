import { SwarmloopError } from '../core/swarmloop-error';
import { makeRepo, runGit, writeFiles } from '../git/git-repo.spec-helpers';
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

  it('reads a check as a command string or as an object with an optional name and paths', () => {
    const checks = fromSwarmloop(
      JSON.stringify({
        version: 1,
        image: 'a',
        checks: [
          'npm test',
          { run: 'npm run lint' },
          { run: 'npm test -w server', name: 'server', paths: ['server/'] },
        ],
      }),
    ).checks;
    expect(checks).toEqual([
      'npm test',
      { run: 'npm run lint' },
      { run: 'npm test -w server', name: 'server', paths: ['server/'] },
    ]);
  });

  it('rejects a check that is neither a string nor an object, and names the accepted forms', () => {
    expect(() => fromSwarmloop(JSON.stringify({ version: 1, image: 'a', checks: [5] }))).toThrow(
      '.swarmloop.json: "checks" entries must be a command string or an object with "run", and optionally "name" and "paths"',
    );
  });

  it.each([
    ['an empty run', { run: '' }, '"checks[0].run" is not allowed to be empty'],
    ['no run', { name: 'x' }, '"checks[0].run" is required'],
    ['an unknown key', { run: 'x', path: ['a'] }, '"checks[0].path" is not allowed'],
    ['paths that are not an array', { run: 'x', paths: 'server/' }, '"checks[0].paths" must be an array'],
    ['empty paths', { run: 'x', paths: [] }, '"checks[0].paths" must contain at least 1 items'],
  ])('rejects a check object with %s and names the field', (_label, entry, message) => {
    expect(() => fromSwarmloop(JSON.stringify({ version: 1, image: 'a', checks: [entry] }))).toThrow(
      `.swarmloop.json: ${message}`,
    );
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

describe('manifest hosts', () => {
  const swarmloop = (hosts: unknown, extra: object = {}) => JSON.stringify({ version: 1, image: 'a', hosts, ...extra });

  it('reads hosts in both formats', () => {
    const hosts = { setup: ['pub.dev', 'storage.googleapis.com'], agent: ['pub.dev'] };
    expect(fromSwarmloop(swarmloop(hosts)).hosts).toEqual(hosts);
    expect(
      fromDevcontainer(JSON.stringify({ image: 'a', customizations: { swarmloop: { hosts } } }), 'x.json').hosts,
    ).toEqual(hosts);
  });

  it('parses a manifest without hosts to the config it had before', () => {
    expect(fromSwarmloop(JSON.stringify({ version: 1, image: 'a' }))).toEqual({
      source: '.swarmloop.json',
      image: 'a',
      cache: [],
      checks: [],
    });
    expect(fromSwarmloop(swarmloop({}))).not.toHaveProperty('hosts');
    expect(fromSwarmloop(swarmloop({ agent: [] }))).not.toHaveProperty('hosts');
  });

  it('refuses hosts for the agent when only the setup reaches the registries', () => {
    const message = '.swarmloop.json: hosts.agent: is not allowed with "network": "setup"';
    expect(() => fromSwarmloop(swarmloop({ agent: ['pub.dev'] }, { network: 'setup' }))).toThrow(message);
    expect(() =>
      fromDevcontainer(
        JSON.stringify({
          image: 'a',
          customizations: { swarmloop: { network: 'setup', hosts: { agent: ['pub.dev'] } } },
        }),
        'x.json',
      ),
    ).toThrow('x.json: hosts.agent: is not allowed');
    expect(fromSwarmloop(swarmloop({ setup: ['pub.dev'] }, { network: 'setup' })).hosts).toEqual({
      setup: ['pub.dev'],
    });
  });

  it('refuses a malformed hosts value', () => {
    expect(() => fromSwarmloop(swarmloop({ setup: 'pub.dev' }))).toThrow(
      '.swarmloop.json: "hosts.setup" must be an array',
    );
    expect(() =>
      fromDevcontainer(JSON.stringify({ image: 'a', customizations: { swarmloop: { hosts: [] } } }), 'x.json'),
    ).toThrow('x.json: hosts:');
  });

  const read = async (hosts: unknown) => readEnvironmentConfig(makeRepo({ '.swarmloop.json': swarmloop(hosts) }));

  it('accepts a host name', async () => {
    expect((await read({ setup: ['pub.dev'] }))?.hosts).toEqual({ setup: ['pub.dev'] });
  });

  it.each([
    ['https://pub.dev', 'is not a host name'],
    ['pub.dev:443', 'is not a host name'],
    ['pub.dev/x', 'is not a host name'],
    ['*.pub.dev', 'is not a host name'],
    ['Pub.dev', 'is not a host name'],
    ['', 'is not a host name'],
    ['10.0.0.1', 'is a local address'],
    ['localhost', 'is a local address'],
    ['github.com', 'is a code host'],
    ['api.anthropic.com', 'is a model API host'],
  ])('refuses the entry %p with its reason', async (host, reason) => {
    await expect(read({ agent: [host] })).rejects.toThrow(`.swarmloop.json: hosts.agent: ${host} ${reason}`);
  });

  it('refuses the host of the checkout origin, naming each entry', async () => {
    const repo = makeRepo({ '.swarmloop.json': swarmloop({ setup: ['git.corp.example'], agent: ['nodejs.org'] }) });
    runGit(repo, ['remote', 'add', 'origin', 'git@git.corp.example:team/app.git']);
    await expect(readEnvironmentConfig(repo)).rejects.toThrow(
      '.swarmloop.json: hosts.setup: git.corp.example is a code host; .swarmloop.json: hosts.agent: nodejs.org is setup-only',
    );
  });

  it('reads hosts from the committed revision only', async () => {
    const repo = makeRepo({ '.swarmloop.json': swarmloop({ setup: ['pub.dev'] }) });
    writeFiles(repo, { '.swarmloop.json': swarmloop({ setup: ['pub.dev', 'evil.example'] }) });
    expect((await readEnvironmentConfig(repo))?.hosts).toEqual({ setup: ['pub.dev'] });
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

  it('does not treat an invalid revision as a repository without checks', async () => {
    await expect(readEnvironmentConfig(makeRepo(), 'missing-revision')).rejects.toThrow(
      'Cannot read project environment',
    );
  });
});
