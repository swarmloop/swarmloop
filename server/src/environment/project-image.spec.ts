import { existsSync } from 'fs';
import { dirname } from 'path';
import { SwarmloopError } from '../core/swarmloop-error';
import type { DockerRunner } from '../sandbox/sandbox.service';
import { commitFiles, makeRepo } from '../git/git-repo.spec-helpers';
import type { EnvironmentConfig } from './environment-config';
import { DEFAULT_PATH, imagePath, resolveProjectImage } from './project-image';

function fakeDocker(local: string[] = [], listed: string[] = []) {
  const images = new Set(local);
  const calls: string[][] = [];
  const built: { file: string; contextExists: boolean }[] = [];
  const docker: DockerRunner = (args) => {
    calls.push(args);
    const [first, second] = args;
    if (first === 'image' && second === 'inspect') {
      return images.has(args.at(-1) ?? '') ? Promise.resolve('[]') : Promise.reject(new Error('No such image'));
    }
    if (first === 'image' && second === 'ls') {
      return Promise.resolve(listed.join('\n'));
    }
    if (first === 'build') {
      images.add(args[2] ?? '');
      const file = args[4] ?? '';
      built.push({ file, contextExists: existsSync(args[5] ?? '') && existsSync(file) && existsSync(dirname(file)) });
    }
    if (first === 'pull') {
      images.add(args[1] ?? '');
    }
    return Promise.resolve('');
  };
  return { docker, calls, built, count: (verb: string) => calls.filter((call) => call[0] === verb).length };
}

const own: EnvironmentConfig = {
  source: '.swarmloop.json',
  dockerfile: '.swarmloop/Dockerfile',
  context: '.swarmloop',
  cache: [],
  checks: [],
};

describe('resolveProjectImage', () => {
  it('pulls a named image only when it is missing', async () => {
    const config: EnvironmentConfig = { source: 'x', image: 'node:22', cache: [], checks: [] };
    const missing = fakeDocker();
    expect(await resolveProjectImage(missing.docker, makeRepo(), 'demo', config)).toBe('node:22');
    expect(missing.count('pull')).toBe(1);
    const present = fakeDocker(['node:22']);
    await resolveProjectImage(present.docker, makeRepo(), 'demo', config);
    expect(present.count('pull')).toBe(0);
  });

  it('builds once per content and builds again when a file in the context changes', async () => {
    const repo = makeRepo({ '.swarmloop/Dockerfile': 'FROM node:22\n', '.swarmloop/a.sh': 'one\n', 'src/x.ts': 'x\n' });
    const fake = fakeDocker();
    const first = await resolveProjectImage(fake.docker, repo, 'My App', own);
    expect(first).toMatch(/^swarmloop-env-my-app:[0-9a-f]{12}$/);
    expect(fake.built[0]?.contextExists).toBe(true);
    expect(await resolveProjectImage(fake.docker, repo, 'My App', own)).toBe(first);
    commitFiles(repo, { 'src/x.ts': 'changed\n' });
    expect(await resolveProjectImage(fake.docker, repo, 'My App', own)).toBe(first);
    commitFiles(repo, { '.swarmloop/a.sh': 'two\n' });
    expect(await resolveProjectImage(fake.docker, repo, 'My App', own)).not.toBe(first);
    expect(fake.count('build')).toBe(2);
  });

  it('builds a devcontainer whose context is the repository root', async () => {
    const repo = makeRepo({ '.devcontainer/Dockerfile': 'FROM php:8.3-cli\n', 'composer.json': '{}\n' });
    const fake = fakeDocker();
    const config: EnvironmentConfig = {
      source: '.devcontainer/devcontainer.json',
      dockerfile: '.devcontainer/Dockerfile',
      context: '.',
      cache: [],
      checks: [],
    };
    await resolveProjectImage(fake.docker, repo, 'demo', config);
    expect(fake.built).toHaveLength(1);
    expect(fake.built[0]?.contextExists).toBe(true);
  });

  it('keeps the two newest older tags', async () => {
    const repo = makeRepo({ '.swarmloop/Dockerfile': 'FROM x\n' });
    const fake = fakeDocker([], ['swarmloop-env-demo:aaa', 'swarmloop-env-demo:bbb', 'swarmloop-env-demo:ccc']);
    await resolveProjectImage(fake.docker, repo, 'demo', own);
    expect(fake.calls.filter((call) => call[0] === 'rmi').map((call) => call[1])).toEqual(['swarmloop-env-demo:ccc']);
  });

  it('says when the Dockerfile is not committed', async () => {
    await expect(resolveProjectImage(fakeDocker().docker, makeRepo(), 'demo', own)).rejects.toThrow(SwarmloopError);
  });
});

describe('imagePath', () => {
  it('reads PATH from the image and falls back to the usual one', async () => {
    const docker: DockerRunner = () => Promise.resolve('["PATH=/usr/local/bin:/usr/bin:/bin","NODE_VERSION=22"]\n');
    expect(await imagePath(docker, 'node:22')).toBe('/usr/local/bin:/usr/bin:/bin');
    const broken: DockerRunner = () => Promise.reject(new Error('x'));
    expect(await imagePath(broken, 'x')).toBe(DEFAULT_PATH);
    const odd: DockerRunner = () => Promise.resolve('["PATH=/a b;rm"]');
    expect(await imagePath(odd, 'x')).toBe(DEFAULT_PATH);
  });
});
