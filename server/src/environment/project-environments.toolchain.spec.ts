import { basename } from 'path';
import { writeFiles } from '../git/git-repo.spec-helpers';
import { RequiredCheckFailed } from './project-environments';
import { manifest, setup } from './project-environments.spec-helpers';

const HEAD_IMAGE = 'node:24-bookworm';
const dockerfileManifest = { version: 1, dockerfile: '.swarmloop/Dockerfile', checks: ['npm test'], cache: [] };
const dockerfile = (text: string) => ({ '.swarmloop/Dockerfile': `FROM node:22\n${text}\n` });

const dockerCalls = (run: ReturnType<typeof setup>['run']) => (verb: string) =>
  run.mock.calls.filter(([args]) => args[0] === verb);

/** A run whose worktree names another image than the one the run started with. */
function movedToNewImage(options: Parameters<typeof setup>[0] = {}) {
  const made = setup({ writes: true, ...options });
  writeFiles(made.input.mounts[0].hostPath, { '.swarmloop.json': JSON.stringify({ ...manifest, image: HEAD_IMAGE }) });
  const images = (shell: string) =>
    made.spawned.filter((launch) => launch.project?.shell === shell).map((launch) => launch.project?.image);
  return { ...made, images, docker: dockerCalls(made.run) };
}

describe('ProjectEnvironments checks on the toolchain the run changed', () => {
  it('runs the checks in the head image and gives the agent the base image', async () => {
    const { service, input, images } = movedToNewImage();
    await service.check(input);
    expect(images('npm test')).toEqual([HEAD_IMAGE]);
    const prepared = await service.prepare(input);
    expect(prepared?.launch.image).toBe(manifest.image);
    expect(prepared?.record.image).toBe(manifest.image);
  });

  it('keeps the base commands, setup and hosts when the head changes the image', async () => {
    const { service, input, spawned } = movedToNewImage();
    await service.check(input);
    expect(spawned.map((launch) => launch.project?.shell)).toEqual(['npm ci', 'npm test']);
    expect(spawned[1]?.allowHosts).toEqual([]);
  });

  it('runs the checks in today image and neither builds nor pulls when the definition did not change', async () => {
    const { service, input, spawned, run } = setup({ writes: true });
    await service.check(input);
    expect(spawned.map((launch) => launch.project?.image)).toEqual([manifest.image, manifest.image]);
    expect(run.mock.calls.filter(([args]) => args[0] === 'build' || args[0] === 'pull')).toEqual([]);
  });

  it('pulls the head image when it is not local', async () => {
    const { service, input, docker } = movedToNewImage({ fresh: true });
    await service.check(input);
    expect(docker('pull').map(([args]) => args[1])).toEqual([HEAD_IMAGE]);
  });

  it('builds a Dockerfile edit of the worktree for the checks and leaves the base tag to the agent', async () => {
    const files = dockerfile('');
    const made = setup({ writes: true, config: dockerfileManifest, files, fresh: true });
    const { service, input, spawned } = made;
    const docker = dockerCalls(made.run);
    writeFiles(input.mounts[0].hostPath, dockerfile('RUN true'));
    await service.check(input);
    const checkImage = spawned[0]?.project?.image;
    const prepared = await service.prepare(input);
    expect(prepared?.launch.image).not.toBe(checkImage);
    expect(docker('build').map(([args]) => args[2])).toEqual([checkImage, prepared?.launch.image]);
  });

  it('runs the setup in the head image, again in the base image for the agent, and once per command and image', async () => {
    const { service, input, images } = movedToNewImage();
    await service.check(input);
    await service.prepare(input);
    await service.prepare({ ...input, step: 'implement-improve' });
    expect(images('npm ci')).toEqual([HEAD_IMAGE, manifest.image]);
    await service.check(input);
    await service.check({ ...input, step: 'checks-again' });
    expect(images('npm ci')).toEqual([HEAD_IMAGE, manifest.image, HEAD_IMAGE]);
  });

  it('returns a head manifest it cannot use to implement and runs nothing', async () => {
    const { service, input, spawned, stored } = setup({ writes: true });
    writeFiles(input.mounts[0].hostPath, { '.swarmloop.json': '{}\n' });
    const failure = await service.check(input).catch((error: unknown) => error);
    const reason = 'the environment definition in the changed files cannot be used';
    expect(failure).toBeInstanceOf(RequiredCheckFailed);
    expect((failure as RequiredCheckFailed).message).toContain(`${basename(input.mounts[0].hostPath)}: ${reason}`);
    expect((failure as RequiredCheckFailed).failed).toEqual([]);
    expect(stored.filter((item) => item.kind === 'return').at(-1)?.body).toContain(reason);
    expect(spawned).toHaveLength(0);
  });

  it('returns a head image that does not build to implement with the build error', async () => {
    const { service, input, spawned, stored } = setup({
      writes: true,
      config: dockerfileManifest,
      files: dockerfile(''),
      fresh: true,
      failingBuild: new Error('step 2 failed'),
    });
    writeFiles(input.mounts[0].hostPath, dockerfile('RUN false'));
    await expect(service.check(input)).rejects.toThrow('image build from .swarmloop/Dockerfile failed: step 2 failed');
    expect(stored.filter((item) => item.kind === 'return').at(-1)?.body).toContain('step 2 failed');
    expect(spawned).toHaveLength(0);
  });

  it('runs the named commands again in the head image', async () => {
    const { service, input, images } = movedToNewImage({ checkCode: 1 });
    const repo = basename(input.mounts[0].hostPath);
    const red = await service.rerun(input, [{ repo, command: 'npm test', tail: 'old' }]);
    expect(images('npm test')).toEqual([HEAD_IMAGE]);
    expect(red.map((item) => item.command)).toEqual(['npm test']);
  });

  it('reports the named commands as red with the reason when the head manifest cannot be used', async () => {
    const { service, input, spawned } = setup({ writes: true });
    writeFiles(input.mounts[0].hostPath, { '.swarmloop.json': '{}\n' });
    const repo = basename(input.mounts[0].hostPath);
    const red = await service.rerun(input, [{ repo, command: 'npm test', tail: 'old' }]);
    expect(red).toHaveLength(1);
    expect(red[0]?.tail).toContain('cannot be used');
    expect(spawned).toHaveLength(0);
  });
});
