import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const fixtures = join(scriptsDir, 'fixtures', 'release');

function generate(componentsFile) {
  const out = mkdtempSync(join(tmpdir(), 'release-manifest-'));
  const result = spawnSync(
    'node',
    [
      join(scriptsDir, 'release-manifest.mjs'),
      componentsFile,
      ...['--version', '1.2.3', '--commit', 'abc1234', '--repo', 'ghcr.io/acme', '--out', out],
    ],
    { encoding: 'utf8' },
  );
  return { result, read: (name) => readFileSync(join(out, name), 'utf8') };
}

test('the manifest lists version, commit, digest refs and CLI versions', () => {
  const { result, read } = generate(join(fixtures, 'components.json'));

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(read('release-manifest.json')),
    JSON.parse(readFileSync(join(fixtures, 'release-manifest.json'), 'utf8')),
  );
});

test('the manifest provides the sandbox image resolver contract', () => {
  const { result, read } = generate(join(fixtures, 'components.json'));

  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(read('release-manifest.json'));
  assert.deepEqual(manifest.images, {
    'agent-claude': manifest.components['swarmloop-agent-claude'],
    'agent-codex': manifest.components['swarmloop-agent-codex'],
    'agent-cursor': manifest.components['swarmloop-agent-cursor'],
    egress: manifest.components['swarmloop-egress'],
  });
});

test('the compose file pins every image by digest and has no registry or version variable left', () => {
  const { read } = generate(join(fixtures, 'components.json'));
  const compose = read('compose.yml');
  const env = read('.env.example');

  const images = compose.split('\n').filter((line) => /^\s*image:/.test(line));
  assert.equal(images.length, 3);
  assert.equal(
    images.every((line) => line.includes('@sha256:')),
    true,
  );
  for (const text of [compose, env]) {
    assert.doesNotMatch(text, /\$\{SWARMLOOP_(REGISTRY|VERSION)|SWARMLOOP_REGISTRY|latest/);
  }
  assert.match(compose, /^ {6}SWARMLOOP_VERSION: 1\.2\.3$/m);
  assert.match(env, /Set these two first/);
  for (const name of ['agent-claude', 'agent-codex', 'agent-cursor', 'egress']) {
    assert.match(compose, new RegExp(`for ref in .*ghcr\\.io/acme/swarmloop-${name}@sha256:`));
  }
});

test('INSTALL.md carries the version and commit', () => {
  const { read } = generate(join(fixtures, 'components.json'));

  assert.match(read('INSTALL.md'), /swarmloop 1\.2\.3[\s\S]*abc1234/);
  assert.doesNotMatch(read('INSTALL.md'), /\{\{/);
});

test('a component without a digest fails', () => {
  const broken = mkdtempSync(join(tmpdir(), 'release-components-'));
  const components = JSON.parse(readFileSync(join(fixtures, 'components.json'), 'utf8'));
  delete components['swarmloop-egress'];
  const file = join(broken, 'components.json');
  writeFileSync(file, JSON.stringify(components));

  const { result } = generate(file);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /swarmloop-egress has no sha256 digest/);
});
