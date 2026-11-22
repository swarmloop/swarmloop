import 'reflect-metadata';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { PassThrough } from 'stream';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { REBASE_CONFLICT } from '../git/rebase';
import type { ProjectLaunch, SandboxLaunch } from '../sandbox/sandbox-launch';
import { createFlowHarness } from './flow-harness';
import { assertInvariants } from './flow-invariants';
import { approvedRun, conflictingRebase } from './implement-flow.spec-helpers';
import { BlockAgentRunner } from './result-answer';
import { git } from './runs.spec-helpers';

const KEY = 'PROJ-470';
const OLD_IMAGE = 'node:22-bookworm';
const NEW_IMAGE = 'node:24-bookworm';
const manifest = (value: object) => ({
  '.swarmloop.json': JSON.stringify({ version: 1, image: OLD_IMAGE, setup: 'npm ci', cache: [], ...value }),
});

/** A docker that knows every image and a container that ends at once; it notes the containers it was asked for. */
function fakeDocker() {
  const spawned: SandboxLaunch[] = [];
  return {
    spawned,
    calls: {
      run: (args: string[]) => {
        const last = args.at(-1) ?? '';
        if (args[0] === 'image' && args.includes('{{.Id}}'))
          return Promise.resolve(`sha256:${createHash('sha256').update(last).digest('hex')}\n`);
        if (args[0] === 'image' && args.includes('{{json .Config.Env}}'))
          return Promise.resolve('["PATH=/usr/bin:/bin"]');
        if (args[0] === 'run' && args.includes('-c') && last.includes('certs='))
          return Promise.resolve('certs=no\nv1\n');
        if (args[0] === 'run' && last.startsWith('test -f')) return Promise.resolve('yes\n');
        return Promise.resolve('');
      },
      spawn: (launch: SandboxLaunch) => {
        spawned.push(launch);
        const child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          containerName: 'swarmloop-flow-toolchain',
        });
        setImmediate(() => child.emit('close', 0));
        return Promise.resolve(child);
      },
      stats: () => Promise.resolve({ cpuPercent: 1, rssBytes: 1024 }),
      stateDaemonPath: (path: string) => Promise.resolve(path),
    },
  };
}

describe('a run that changes its toolchain or its dependencies, on the real implement and checks steps', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let blocks: BlockAgentRunner;
  let docker: ReturnType<typeof fakeDocker>;
  /** The image every agent launch of a step was given. */
  let agentImages: string[];
  let onAgent: (step: string, prompt: string) => void = () => undefined;

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  const documents = () => flow.app.app.get(DocumentRepository);

  /** The app is up with the repository files; what the agent does to the worktree is `onAgent`. */
  async function boot(repoFiles?: Record<string, string>): Promise<void> {
    blocks = new BlockAgentRunner();
    docker = fakeDocker();
    agentImages = [];
    flow = await createFlowHarness(KEY, {
      blocks,
      realImplement: 'all',
      realSteps: ['checks'],
      repoFiles,
      sandboxCalls: docker.calls,
    });
    const delegate = blocks.run.bind(blocks);
    jest.spyOn(blocks, 'run').mockImplementation((input) => {
      const { project } = input as typeof input & { project?: ProjectLaunch };
      if (project) agentImages.push(project.image);
      onAgent(input.step, input.prompt ?? '');
      return delegate(input);
    });
  }

  async function runImplement(): Promise<void> {
    await approvedRun(flow, KEY, 'implement');
    await flow.person('resume');
  }

  const checkImages = () => docker.spawned.filter((launch) => launch.allowHosts.length === 0);
  const ran = () => checkImages().map((launch) => launch.project?.shell);

  it('checks a run that moves the manifest image in the new image, while the agent keeps the old one', async () => {
    await boot(manifest({ checks: ['npm test'] }));
    onAgent = (step) =>
      step === 'implement' &&
      writeFileSync(
        join(flow.tree, '.swarmloop.json'),
        manifest({ image: NEW_IMAGE, checks: ['npm test'] })['.swarmloop.json'],
      );
    await runImplement();

    expect((await flow.app.app.get(RunRepository).findRun(KEY))?.currentStep).toBe('done');
    expect(checkImages().map((launch) => launch.project?.image)).toEqual([NEW_IMAGE]);
    expect(agentImages.length).toBeGreaterThan(0);
    expect(new Set(agentImages)).toEqual(new Set([OLD_IMAGE]));
    await assertInvariants(flow.app);
  });

  it('runs every check when the run changes only a root lockfile', async () => {
    const checks = [
      { run: 'npm test', paths: ['src/'] },
      { run: 'npm run lint', paths: ['src/'] },
    ];
    await boot(manifest({ checks }));
    onAgent = (step) => step === 'implement' && writeFileSync(join(flow.tree, 'package-lock.json'), '{}\n');
    await runImplement();

    expect((await flow.app.app.get(RunRepository).findRun(KEY))?.currentStep).toBe('done');
    expect(ran().sort()).toEqual(['npm run lint', 'npm test']);
    await assertInvariants(flow.app);
  });

  it('ends with no conflict marker when a rebase conflicts in a lockfile', async () => {
    const baseLock = '{ "from": "the base" }\n';
    const regenerated = '{ "from": "the base", "added": "by this branch" }\n';
    await boot();
    const run = await approvedRun(flow, KEY, 'implement');
    await documents().putDocument(run, 'implementation', '- changed the dependencies\n');
    conflictingRebase(flow, { file: 'package-lock.json', feature: '{ "from": "the branch" }\n', base: baseLock });
    await documents().putDocument(run, REBASE_CONFLICT, 'pending\n');
    onAgent = (_step, prompt) => {
      if (prompt.includes("keep the new base's version of it")) {
        // The base version, then what the package manager writes for this branch's manifest.
        writeFileSync(join(flow.tree, 'package-lock.json'), regenerated);
      }
    };

    await flow.person('resume');

    expect(blocks.prompts.some((launch) => launch.step === 'rebase')).toBe(true);
    expect(git(flow.tree, ['show', 'HEAD:package-lock.json'])).not.toContain('<<<<<<<');
    expect(git(flow.tree, ['show', 'HEAD:package-lock.json'])).toBe(regenerated.trim());
    expect((await flow.app.app.get(RunRepository).findRun(KEY))?.currentStep).toBe('done');
    await assertInvariants(flow.app);
  });

  it('gives the setup and every check command its own /tmp folder of the run', async () => {
    await boot(manifest({ checks: ['npm test', 'npm run lint'] }));
    await runImplement();

    const folders = docker.spawned.map((launch) => launch.tmp?.hostPath ?? '');
    expect(folders.length).toBeGreaterThanOrEqual(3);
    for (const folder of folders) {
      expect(folder).toMatch(/\/worktrees\/\.tmp\/PROJ-470\/(setup-[^/]+|checks-[^/]+-\d)$/);
    }
    expect(new Set(folders).size).toBe(folders.length);
    expect(docker.spawned.every((launch) => launch.tmp?.containerPath === '/tmp')).toBe(true);
    await assertInvariants(flow.app);
  });
});
