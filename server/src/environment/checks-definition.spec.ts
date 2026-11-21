import { basename } from 'path';
import { writeFiles } from '../git/git-repo.spec-helpers';
import { checksDefinition, HeadEnvironmentUnreadable } from './checks-definition';
import type { EnvironmentRecord } from './environment-types';
import { fromSwarmloop } from './environment-config';
import { copiedRepo } from './project-repo.spec-helpers';

const base = {
  version: 1,
  image: 'node:22',
  setup: 'npm ci',
  checks: ['npm test'],
  cache: ['/home/sandbox/.npm'],
  hosts: { setup: ['pub.dev'] },
};
const manifestFile = (value: unknown) => ({ '.swarmloop.json': JSON.stringify(value) });

function runOn(files: Record<string, string>) {
  const repo = copiedRepo(files);
  const record: EnvironmentRecord = {
    repo: basename(repo),
    ref: 'base-ref',
    config: fromSwarmloop(files['.swarmloop.json'] ?? ''),
  };
  return { repo, record, mount: { hostPath: repo, containerPath: '/work' } };
}

describe('checksDefinition', () => {
  it('gives back the base definition when the head did not change the environment', async () => {
    const { mount, record } = runOn(manifestFile(base));
    expect((await checksDefinition(mount, record)).config).toEqual(record.config);
  });

  it('takes the image from the head and everything else from the base', async () => {
    const { repo, mount, record } = runOn(manifestFile(base));
    writeFiles(
      repo,
      manifestFile({ ...base, image: 'node:24', checks: ['true'], setup: 'x', hosts: { setup: ['evil.example'] } }),
    );
    const source = await checksDefinition(mount, record);
    expect(source.config).toMatchObject({
      image: 'node:24',
      setup: 'npm ci',
      checks: ['npm test'],
      hosts: { setup: ['pub.dev'] },
    });
    expect(source.ref).not.toBe('base-ref');
  });

  it('drops the image the head replaced with a Dockerfile', async () => {
    const { repo, mount, record } = runOn(manifestFile(base));
    writeFiles(repo, {
      ...manifestFile({ version: 1, dockerfile: '.swarmloop/Dockerfile' }),
      '.swarmloop/Dockerfile': 'FROM node:24\n',
    });
    const { config } = await checksDefinition(mount, record);
    expect(config.image).toBeUndefined();
    expect(config).toMatchObject({ dockerfile: '.swarmloop/Dockerfile', context: '.swarmloop', checks: ['npm test'] });
  });

  it('reads an uncommitted Dockerfile edit through the tree of the worktree', async () => {
    const files = {
      ...manifestFile({ version: 1, dockerfile: '.swarmloop/Dockerfile' }),
      '.swarmloop/Dockerfile': 'FROM node:22\n',
    };
    const { repo, mount, record } = runOn(files);
    const first = await checksDefinition(mount, record);
    writeFiles(repo, { '.swarmloop/Dockerfile': 'FROM node:24\n' });
    const second = await checksDefinition(mount, record);
    expect(second.ref).toMatch(/^[0-9a-f]{40}/);
    expect(second.ref).not.toBe(first.ref);
  });

  it('keeps the base definition when the head names no environment', async () => {
    const { repo, mount, record } = runOn(manifestFile(base));
    writeFiles(repo, manifestFile({ version: 1, git: { target: 'main' } }));
    expect(await checksDefinition(mount, record)).toEqual({ config: record.config, ref: 'base-ref' });
  });

  it('throws HeadEnvironmentUnreadable for a head manifest that is not valid', async () => {
    const { repo, mount, record } = runOn(manifestFile(base));
    writeFiles(repo, { '.swarmloop.json': '{}' });
    await expect(checksDefinition(mount, record)).rejects.toBeInstanceOf(HeadEnvironmentUnreadable);
  });

  it('throws HeadEnvironmentUnreadable for a head manifest whose host the ceiling refuses', async () => {
    const { repo, mount, record } = runOn(manifestFile(base));
    writeFiles(repo, manifestFile({ ...base, hosts: { setup: ['*'] } }));
    await expect(checksDefinition(mount, record)).rejects.toThrow('cannot be used');
  });

  it('returns a head devcontainer whose Dockerfile path is an option, and builds nothing from it', async () => {
    const { repo, mount, record } = runOn(manifestFile(base));
    writeFiles(repo, {
      '.swarmloop.json': JSON.stringify({ version: 1, git: { target: 'main' } }),
      '.devcontainer.json': '{"build":{"dockerfile":"--output=/tmp/x"}}',
    });
    await expect(checksDefinition(mount, record)).rejects.toBeInstanceOf(HeadEnvironmentUnreadable);
  });
});
