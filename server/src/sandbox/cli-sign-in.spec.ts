import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppConfig } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import { FakeCliSandbox } from '../testing/fake-cli';
import { CliSignIn } from './cli-sign-in';
import type { SandboxService } from './sandbox.service';

describe('CliSignIn', () => {
  let root: string;
  let sandbox: FakeCliSandbox;
  let cli: CliSignIn;
  const request = (key: string) => ({
    runtime: 'claude',
    command: ['tool', 'login'],
    hosts: ['login.example.com'],
    key,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cli-sign-in-'));
    sandbox = new FakeCliSandbox();
    cli = new CliSignIn(new AppConfig(testEnv({ SWARMLOOP_ROOT: root })), sandbox as unknown as SandboxService);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('runs the command in the runtime image with no credential, an open stdin and the sign-in hosts', async () => {
    await cli.run(request('one'));
    const [launch] = sandbox.launches;
    expect(launch).toMatchObject({ runtime: 'claude', command: ['tool', 'login'], stdin: true });
    expect(launch.env).toBeUndefined();
    expect(launch.allowHosts).toEqual(expect.arrayContaining(['api.anthropic.com', 'login.example.com']));
    expect(launch.mounts).toEqual([{ hostPath: join(root, 'worktrees'), containerPath: '/work' }]);
  });

  it('names the container by the key, so two sign-ins never share one', async () => {
    await cli.run(request('one'));
    await cli.run(request('two'));
    const [first, second] = sandbox.children.map((child) => child.containerName);
    expect(first).not.toBe(second);
  });

  it('hands what is written to the CLI, and gives its output without terminal escapes', async () => {
    const run = await cli.run(request('one'));
    sandbox.children[0].say('\u001B[1mOpen\u001B[0m https://example.com/x\n');
    sandbox.children[0].complain('\u001B]0;title\u0007waiting for the code');
    run.write('abc\n');
    expect(sandbox.children[0].written).toEqual(['abc\n']);
    expect(run.output()).toBe('Open https://example.com/x\nwaiting for the code');
  });

  it('keeps the last 64 KB of the output', async () => {
    const run = await cli.run(request('one'));
    sandbox.children[0].say(`start${'x'.repeat(70 * 1024)}end`);
    expect(run.output()).toHaveLength(64 * 1024);
    expect(run.output().endsWith('end')).toBe(true);
    expect(run.output()).not.toContain('start');
  });

  it('closes stdin, removes the container and gives the exit code when the CLI exits', async () => {
    const run = await cli.run(request('one'));
    sandbox.children[0].exit(3);
    await expect(run.exited).resolves.toBe(3);
    expect(sandbox.children[0].stdinEnded).toBe(true);
    expect(sandbox.removed).toEqual([sandbox.children[0].containerName]);
  });

  it('removes the container and gives no code when the process cannot run', async () => {
    const run = await cli.run(request('one'));
    sandbox.children[0].crash('docker went away');
    await expect(run.exited).resolves.toBeNull();
    expect(run.output()).toContain('docker went away');
    expect(sandbox.removed).toEqual([sandbox.children[0].containerName]);
  });

  it('removes the container once when stopped, and again safely after the exit', async () => {
    const run = await cli.run(request('one'));
    await run.stop();
    sandbox.children[0].exit(137);
    await run.exited;
    expect(sandbox.removed).toHaveLength(1);
  });
});
