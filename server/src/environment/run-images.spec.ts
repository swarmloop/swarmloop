import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RunStop } from '../agent/run-stop';
import { ERROR_CODES } from '../contract/error-codes';
import type { RunEntity } from '../history/entities';
import type { VisitRepository } from '../history/visit.repository';
import { ImagePreparation } from '../sandbox/image-prepare';
import type { RunImages } from '../sandbox/image-resolver';
import type { SandboxService } from '../sandbox/sandbox.service';
import type { AgentProcessRunner } from '../agent/agent-runner';
import { StepStopped } from '../steps/shared/step-stopped';
import { AgentLauncher } from '../steps/shared/agent-launcher';
import { IMAGES } from './run-images';

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const ARCH = process.arch === 'x64' ? 'amd64' : process.arch;
const ref = (digest: string) => `registry.example/swarmloop/agent-claude@${digest}`;
const egress = (digest: string) => `registry.example/swarmloop/egress@${digest}`;

let manifestPath = '';

function release(version: string, digest: string): void {
  writeFileSync(
    manifestPath,
    JSON.stringify({ version, images: { 'agent-claude': ref(digest), egress: egress(digest) } }),
  );
}

/** A docker that knows which references are on the machine and fails pulls the way a spec says. */
function setup(options: { pullError?: string; onPull?: () => void } = {}) {
  const present = new Set<string>();
  const ready = new Map<string, RunImages>();
  const pulled: string[] = [];
  const docker = jest.fn(async (args: string[]) => {
    const target = args.at(-1) ?? '';
    if (args[0] === 'pull') {
      pulled.push(target);
      options.onPull?.();
      await new Promise((resolve) => setImmediate(resolve));
      if (options.pullError) throw new Error(options.pullError);
      present.add(target);
      return '';
    }
    if (args[0] === 'image' && args.includes('{{.Id}}')) {
      if (!present.has(target)) throw new Error('No such image');
      return 'sha256:0123456789abcdef\n';
    }
    if (args[0] === 'image') {
      return `linux/${ARCH} ${JSON.stringify({ 'org.opencontainers.image.version': currentVersion() })}\n`;
    }
    return '';
  });
  const stored = new Map<string, string>();
  const documents = {
    latestBody: (_key: string, kind: string) => Promise.resolve(stored.get(kind) ?? null),
    putDocument: (_run: RunEntity, kind: string, body: string) => Promise.resolve(void stored.set(kind, body)),
  };
  const agent = jest.fn().mockResolvedValue({ calls: 1, usd: 0 });
  const runStop = new RunStop();
  const sandbox = {
    images: new ImagePreparation(docker, { retryDelaysMs: [] }),
    startedWith: (key: string, images: RunImages) => void ready.set(key, images),
    imagesOf: (key: string) => ready.get(key),
  } as unknown as SandboxService;
  const launcher = new AgentLauncher(
    { run: agent } as unknown as AgentProcessRunner,
    {} as unknown as VisitRepository,
    runStop,
    sandbox,
    documents as never,
  );
  const run = { key: 'RUN-1', runtime: 'claude', agentCalls: 0 } as RunEntity;
  return { docker, present, pulled, stored, launcher, runStop, run, agent };
}

function currentVersion(): string {
  return JSON.parse(readFileSync(manifestPath, 'utf8')).version as string;
}

describe('images of a run', () => {
  const previous = process.env.SWARMLOOP_RELEASE_MANIFEST;
  beforeEach(() => {
    manifestPath = join(mkdtempSync(join(tmpdir(), 'swarmloop-release-')), 'release.json');
    process.env.SWARMLOOP_RELEASE_MANIFEST = manifestPath;
    release('1.0.0', DIGEST_A);
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.SWARMLOOP_RELEASE_MANIFEST;
    else process.env.SWARMLOOP_RELEASE_MANIFEST = previous;
  });

  it('pulls a missing image once for two runs that start together, and stores what they started with', async () => {
    const { launcher, run, pulled, stored } = setup();
    const other = { ...run, key: 'RUN-2' };
    const [first, second] = await Promise.all([launcher.prepareImages(run), launcher.prepareImages(other)]);
    expect(pulled).toEqual([ref(DIGEST_A), egress(DIGEST_A)]);
    expect(first?.agent.ref).toBe(ref(DIGEST_A));
    expect(second?.agent.ref).toBe(ref(DIGEST_A));
    expect(JSON.parse(stored.get(IMAGES) ?? '{}')).toMatchObject({ agent: { ref: ref(DIGEST_A) }, egress: {} });
  });

  it('keeps release A for a run that started on it after the manifest moves to B', async () => {
    const { launcher, run, present } = setup();
    await launcher.prepareImages(run);
    release('2.0.0', DIGEST_B);
    const again = await launcher.prepareImages(run);
    expect(again?.agent.ref).toBe(ref(DIGEST_A));
    expect(present.has(ref(DIGEST_B))).toBe(false);
  });

  it('does not pull again when a stopped run is resumed', async () => {
    const { launcher, run, pulled, runStop } = setup({ onPull: () => runStop.halt('RUN-1') });
    await expect(launcher.prepareImages(run)).rejects.toBeInstanceOf(StepStopped);
    const first = pulled.length;
    runStop.clear('RUN-1');
    await launcher.prepareImages(run);
    expect(pulled).toHaveLength(first);
  });

  it('does not launch the agent when Stop arrives during the pull', async () => {
    const { launcher, run, runStop, agent } = setup({ onPull: () => runStop.halt('RUN-1') });
    await expect(launcher.launch({ key: 'RUN-1', run } as never)).rejects.toBeInstanceOf(StepStopped);
    expect(agent).not.toHaveBeenCalled();
  });

  it.each([
    ['unauthorized: authentication required', ERROR_CODES.REGISTRY_AUTH],
    ['dial tcp: i/o timeout', ERROR_CODES.REGISTRY_UNREACHABLE],
    ['no matching manifest for linux/arm64', ERROR_CODES.ARCH_UNSUPPORTED],
  ])('blocks with the matching code and leaves the counts alone when the pull says %s', async (pullError, code) => {
    const { launcher, run, agent } = setup({ pullError });
    await expect(launcher.launch({ key: 'RUN-1', run } as never)).rejects.toMatchObject({ code });
    expect(agent).not.toHaveBeenCalled();
    expect(run.agentCalls).toBe(0);
  });

  it('checks nothing again on a later launch of the same run', async () => {
    const { launcher, run, docker } = setup();
    await launcher.prepareImages(run);
    const calls = docker.mock.calls.length;
    await launcher.prepareImages(run);
    expect(docker.mock.calls).toHaveLength(calls);
  });

  it('leaves a run without a manifest alone', async () => {
    delete process.env.SWARMLOOP_RELEASE_MANIFEST;
    const { launcher, run, pulled, stored } = setup();
    await expect(launcher.prepareImages(run)).resolves.toBeUndefined();
    expect(pulled).toEqual([]);
    expect(stored.size).toBe(0);
  });
});
