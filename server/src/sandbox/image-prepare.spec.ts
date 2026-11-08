import { ERROR_CODES } from '../contract/error-codes';
import { ImagePreparation } from './image-prepare';
import { imageOf, resolveImage } from './image-resolver';

const REF = `registry.example/swarmloop/agent-claude@sha256:${'b'.repeat(64)}`;
const ID = 'sha256:0123456789abcdef';
const ARCH = process.arch === 'x64' ? 'amd64' : process.arch;

interface State {
  present: boolean;
  pullFails: string[];
  platform: string;
  labels: Record<string, string>;
  pulls: number;
  infoFails: boolean;
}

function fakeDocker(overrides: Partial<State> = {}) {
  const state: State = {
    present: false,
    pullFails: [],
    platform: `linux/${ARCH}`,
    labels: { 'org.opencontainers.image.version': '1.0.0' },
    pulls: 0,
    infoFails: false,
    ...overrides,
  };
  const docker = jest.fn(async (args: string[]) => {
    if (args[0] === 'info') {
      if (state.infoFails) throw new Error('Cannot connect to the Docker daemon');
      return '';
    }
    if (args[0] === 'pull') {
      state.pulls += 1;
      await new Promise((resolve) => setImmediate(resolve));
      const failure = state.pullFails.shift();
      if (failure) throw new Error(failure);
      state.present = true;
      return 'Pulled\n';
    }
    if (args.includes('{{.Id}}')) {
      if (!state.present) throw new Error('No such image');
      return `${ID}\n`;
    }
    return `${state.platform} ${JSON.stringify(state.labels)}\n`;
  });
  return { state, docker };
}

const release = { ...imageOf(REF), version: '1.0.0' };
const prepared = (docker: ReturnType<typeof fakeDocker>['docker']) =>
  new ImagePreparation(docker, { retryDelaysMs: [0, 0], sleep: () => Promise.resolve() });

describe('ImagePreparation', () => {
  it('pulls a missing registry image once for runs that wait together, and both continue', async () => {
    const { state, docker } = fakeDocker();
    const images = prepared(docker);
    const both = await Promise.all([images.prepare(release), images.prepare(release)]);
    expect(state.pulls).toBe(1);
    expect(both).toEqual([
      { ref: REF, id: ID },
      { ref: REF, id: ID },
    ]);
  });

  it('does not pull an image that is already there', async () => {
    const { state, docker } = fakeDocker({ present: true });
    await expect(prepared(docker).prepare(release)).resolves.toEqual({ ref: REF, id: ID });
    expect(state.pulls).toBe(0);
  });

  it.each([
    ['unauthorized: authentication required', ERROR_CODES.REGISTRY_AUTH],
    ['no matching manifest for linux/arm64/v8 in the manifest list entries', ERROR_CODES.ARCH_UNSUPPORTED],
    ['manifest unknown', ERROR_CODES.IMAGE_MISSING],
    ['dial tcp: lookup registry.example: no such host', ERROR_CODES.REGISTRY_UNREACHABLE],
  ])('gives %s the code %s', async (failure, code) => {
    const { docker } = fakeDocker({ pullFails: Array(10).fill(failure) });
    await expect(prepared(docker).prepare(release)).rejects.toMatchObject({ code });
  });

  it('retries a network error with a bounded backoff and then succeeds', async () => {
    const { state, docker } = fakeDocker({ pullFails: ['i/o timeout', 'connection reset by peer'] });
    await expect(prepared(docker).prepare(release)).resolves.toEqual({ ref: REF, id: ID });
    expect(state.pulls).toBe(3);
  });

  it('stops retrying after the last delay', async () => {
    const { state, docker } = fakeDocker({ pullFails: Array(10).fill('i/o timeout') });
    await expect(prepared(docker).prepare(release)).rejects.toMatchObject({ code: ERROR_CODES.REGISTRY_UNREACHABLE });
    expect(state.pulls).toBe(3);
  });

  it('does not retry a refusal', async () => {
    const { state, docker } = fakeDocker({ pullFails: ['denied: requested access to the resource is denied'] });
    await expect(prepared(docker).prepare(release)).rejects.toMatchObject({ code: ERROR_CODES.REGISTRY_AUTH });
    expect(state.pulls).toBe(1);
  });

  it('refuses a pulled image of another platform', async () => {
    const { docker } = fakeDocker({ platform: 'linux/s390x' });
    await expect(prepared(docker).prepare(release)).rejects.toMatchObject({ code: ERROR_CODES.ARCH_UNSUPPORTED });
  });

  it('refuses a pulled image that is not the release version', async () => {
    const { docker } = fakeDocker({ labels: { 'org.opencontainers.image.version': '0.9.0' } });
    await expect(prepared(docker).prepare(release)).rejects.toMatchObject({ code: ERROR_CODES.IMAGE_MISSING });
  });

  it('reports a docker that does not answer', async () => {
    const { docker } = fakeDocker({ infoFails: true });
    await expect(prepared(docker).prepare(release)).rejects.toMatchObject({
      code: ERROR_CODES.DOCKER_UNAVAILABLE,
      message: 'docker is not running',
    });
  });

  it('shares a failure with every waiting run and tries again later', async () => {
    const { state, docker } = fakeDocker({ pullFails: ['unauthorized'] });
    const images = prepared(docker);
    const outcomes = await Promise.allSettled([images.prepare(release), images.prepare(release)]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
    expect(state.pulls).toBe(1);
    await expect(images.prepare(release)).resolves.toEqual({ ref: REF, id: ID });
  });

  it('never pulls or builds a local name', async () => {
    const { state, docker } = fakeDocker();
    const local = resolveImage('agent-claude', undefined);
    await expect(prepared(docker).prepare(local)).resolves.toEqual({ ref: local.ref });
    expect(state.pulls).toBe(0);
    expect(docker.mock.calls.some((call) => call[0][0] === 'build')).toBe(false);
  });
});
