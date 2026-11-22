import type { EventEmitter } from 'events';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { SystemClock } from '../core/clock';
import type { SandboxLaunch } from '../sandbox/sandbox-launch';
import { AgentProcessRunner } from './agent-runner';
import type { AgentRunInput } from './agent-runner';
import { RunStop } from './run-stop';
import { config, fakeChild, input, sandbox, writePriceCache } from './agent-runner.spec-helpers';

const project = {
  image: 'swarmloop-env-demo:0123456789ab',
  cliVolume: 'swarmloop-cli-cursor-0123456789ab',
  path: '/usr/local/bin:/usr/bin:/bin',
  certFile: true,
  caches: [],
};

const stream = `${JSON.stringify({ session_id: 'chat-9' })}\n${JSON.stringify({ type: 'result', result: 'done' })}\n`;

/** One visit of an agent in the given root. The container's own write into /tmp is `scratch`. */
async function visit(root: string, patch: Partial<AgentRunInput>): Promise<{ launch: SandboxLaunch; seen: string[] }> {
  const launches: SandboxLaunch[] = [];
  const seen: string[][] = [];
  const spawn = jest.fn<Promise<EventEmitter>, [SandboxLaunch]>((launch) => {
    launches.push(launch);
    const tmp = launch.tmp?.hostPath;
    seen.push(tmp && existsSync(tmp) ? readdirSync(tmp) : []);
    if (tmp) {
      writeFileSync(join(tmp, 'scratch'), 'x');
    }
    return Promise.resolve(fakeChild([stream], 0));
  });
  const runner = new AgentProcessRunner(config(root), new SystemClock(), sandbox(spawn), new RunStop());
  await runner.run(input(root, join(root, 'data', 'run1-implement-output.txt'), patch));
  return { launch: launches[0], seen: seen[0] ?? [] };
}

describe('the /tmp of an agent in the project image', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'swarmloop-agent-tmp-'));
    mkdirSync(join(root, 'data'), { recursive: true });
    writePriceCache(root);
  });

  it('is a folder of the run under worktrees/.tmp, empty for a new chat', async () => {
    const { launch, seen } = await visit(root, { project, resumeChatId: null });
    expect(launch.tmp).toEqual({
      hostPath: join(root, 'worktrees', '.tmp', 'run1', 'implement'),
      containerPath: '/tmp',
    });
    expect(seen).toEqual([]);
  });

  it('keeps its files for a visit that resumes the chat, also from implement-improve', async () => {
    await visit(root, { project, resumeChatId: null });
    expect((await visit(root, { project, resumeChatId: 'chat-9' })).seen).toEqual(['scratch']);
    expect((await visit(root, { project, resumeChatId: 'chat-9', step: 'implement-improve' })).seen).toEqual([
      'scratch',
    ]);
  });

  it('is empty again for a later visit that starts a new chat', async () => {
    await visit(root, { project, resumeChatId: null });
    expect((await visit(root, { project, resumeChatId: null })).seen).toEqual([]);
  });

  it('is not given to an agent that runs no project command', async () => {
    const { launch } = await visit(root, { resumeChatId: null });
    expect(launch.tmp).toBeUndefined();
  });
});
