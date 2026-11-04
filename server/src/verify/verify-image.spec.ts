import { SwarmloopError } from '../core/swarmloop-error';
import type { DockerRunner } from '../sandbox/sandbox.service';
import { makeRepo, writeFiles } from './git-repo.spec-helpers';
import type { SwarmloopManifest } from './manifest';
import { projectSlug, resolveVerifyImage } from './verify-image';

const files = { '.swarmloop/Dockerfile': 'FROM node:22\n', '.swarmloop/extra.sh': 'echo hi\n' };
const byDockerfile: SwarmloopManifest = {
  version: 1,
  dockerfile: '.swarmloop/Dockerfile',
  verify: ['true'],
  timeoutMin: 15,
};

/** A docker that knows a set of local images and records every call. */
function fakeDocker(local: string[] = [], listed: string[] = []) {
  const images = new Set(local);
  const calls: string[][] = [];
  const docker: DockerRunner = (args) => {
    calls.push(args);
    const [first, second] = args;
    if (first === 'image' && second === 'inspect') {
      return images.has(args[2] ?? '') ? Promise.resolve('[]') : Promise.reject(new Error('No such image'));
    }
    if (first === 'image' && second === 'ls') {
      return Promise.resolve(listed.join('\n'));
    }
    if (first === 'build') {
      images.add(args[2] ?? '');
    }
    if (first === 'pull') {
      images.add(args[1] ?? '');
    }
    return Promise.resolve('');
  };
  const count = (verb: string) => calls.filter((call) => call[0] === verb).length;
  return { docker, calls, count };
}

function resolve(repo: string, docker: DockerRunner, manifest = byDockerfile) {
  return resolveVerifyImage({ docker, repoPath: repo, baseRef: 'main', project: 'Demo App', manifest });
}

describe('resolveVerifyImage', () => {
  it('gives the same tag for the same files and a new one when a file changes', async () => {
    const first = await resolve(makeRepo(files), fakeDocker().docker);
    const same = await resolve(makeRepo(files), fakeDocker().docker);
    const changed = await resolve(makeRepo({ ...files, '.swarmloop/extra.sh': 'echo changed\n' }), fakeDocker().docker);
    expect(first).toMatch(/^swarmloop-verify-demo-app:[0-9a-f]{12}$/);
    expect(same).toBe(first);
    expect(changed).not.toBe(first);
  });

  it('reads the base ref, not the worktree', async () => {
    const repo = makeRepo(files);
    const before = await resolve(repo, fakeDocker().docker);
    writeFiles(repo, { '.swarmloop/Dockerfile': 'FROM evil\n' });
    expect(await resolve(repo, fakeDocker().docker)).toBe(before);
  });

  it('builds the Dockerfile once and then finds the tag', async () => {
    const repo = makeRepo(files);
    const fake = fakeDocker();
    const tag = await resolve(repo, fake.docker);
    expect(fake.count('build')).toBe(1);
    const build = fake.calls.find((call) => call[0] === 'build') ?? [];
    expect(build.slice(0, 3)).toEqual(['build', '-t', tag]);
    expect(build[3]).toBe('-f');
    expect(build[4]).toMatch(/\.swarmloop\/Dockerfile$/);
    await resolve(repo, fake.docker);
    expect(fake.count('build')).toBe(1);
  });

  it('builds nothing when the tag already exists', async () => {
    const repo = makeRepo(files);
    const tag = await resolve(repo, fakeDocker().docker);
    const fake = fakeDocker([tag]);
    expect(await resolve(repo, fake.docker)).toBe(tag);
    expect(fake.count('build')).toBe(0);
  });

  it('removes tags beyond the newest 3 after a build', async () => {
    const repo = makeRepo(files);
    const current = await resolve(repo, fakeDocker().docker);
    const old = ['a', 'b', 'c', 'd'].map((suffix) => `swarmloop-verify-demo-app:${suffix}`);
    const fake = fakeDocker([], [old[0] ?? '', current, ...old.slice(1)]);
    await resolve(repo, fake.docker);
    const removed = fake.calls.filter((call) => call[0] === 'rmi').map((call) => call[1]);
    expect(removed).toEqual([old[2], old[3]]);
  });

  it('ignores an rmi failure', async () => {
    const repo = makeRepo(files);
    const tags = ['a', 'b', 'c', 'd'].map((suffix) => `swarmloop-verify-demo-app:${suffix}`);
    const inner = fakeDocker([], tags);
    const docker: DockerRunner = (args, timeout) =>
      args[0] === 'rmi' ? Promise.reject(new Error('in use')) : inner.docker(args, timeout);
    await expect(resolve(repo, docker)).resolves.toMatch(/^swarmloop-verify-demo-app:/);
  });

  it('fails when the Dockerfile is not on the base ref', async () => {
    const repo = makeRepo({ '.swarmloop/other': 'x' });
    await expect(resolve(repo, fakeDocker().docker)).rejects.toThrow('.swarmloop/Dockerfile is missing on main');
  });

  it('fails when the base ref has no .swarmloop directory', async () => {
    await expect(resolve(makeRepo(), fakeDocker().docker)).rejects.toThrow(SwarmloopError);
  });

  it('pulls an image only when it is missing locally', async () => {
    const manifest: SwarmloopManifest = { version: 1, image: 'node:22', verify: ['true'], timeoutMin: 15 };
    const fake = fakeDocker();
    expect(await resolve(makeRepo(), fake.docker, manifest)).toBe('node:22');
    expect(fake.count('pull')).toBe(1);
    await resolve(makeRepo(), fake.docker, manifest);
    expect(fake.count('pull')).toBe(1);
    const present = fakeDocker(['node:22']);
    await resolve(makeRepo(), present.docker, manifest);
    expect(present.count('pull')).toBe(0);
  });

  it('reports a failed pull', async () => {
    const manifest: SwarmloopManifest = { version: 1, image: 'node:22', verify: ['true'], timeoutMin: 15 };
    const docker: DockerRunner = () => Promise.reject(new Error('docker is down'));
    await expect(resolve(makeRepo(), docker, manifest)).rejects.toThrow(
      'image node:22 cannot be pulled: docker is down',
    );
  });
});

describe('projectSlug', () => {
  it('lowercases and replaces characters docker does not allow', () => {
    expect(projectSlug('My Project/x')).toBe('my-project-x');
  });
});
