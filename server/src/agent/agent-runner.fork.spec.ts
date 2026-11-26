import type { EventEmitter } from 'events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import { ContainerGate } from '../sandbox/container-gate';
import { heldSpawn } from '../sandbox/container-gate.spec-helpers';
import type { SandboxService } from '../sandbox/sandbox.service';
import { AgentProcessRunner } from './agent-runner';
import type { AgentRunInput } from './agent-runner';
import { RunStop } from './run-stop';
import { config, fakeChild, input, sandbox, writePriceCache } from './agent-runner.spec-helpers';

const SESSION = '{"chatId":"chat-1","resumed":true,"completed":true,"killReason":null,"runtime":"claude"}\n';

/** A runner whose children are scripted, behind the real gate with one agent place. */
async function setup(children: (() => Promise<EventEmitter>)[]) {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-agent-fork-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  writePriceCache(root);
  const cfg = config(root, { AGENTS_PARALLEL: 1 });
  const gate = new ContainerGate(cfg);
  const launches: Parameters<SandboxService['spawn']>[0][] = [];
  const spawn = jest.fn(
    heldSpawn(gate, (launch) => {
      launches.push(launch);
      return (children.shift() as () => Promise<EventEmitter>)();
    }),
  );
  const runner = new AgentProcessRunner(cfg, new FakeClock(), sandbox(spawn), new RunStop());
  const sessionFile = join(root, 'data', 'run1-implement-session.json');
  writeFileSync(sessionFile, SESSION);
  const run = (patch: Partial<AgentRunInput>) =>
    runner.run(
      input(root, join(root, 'data', 'run1-implement-output.txt'), {
        runtime: 'claude',
        sessionFile,
        ...patch,
      }),
    );
  return { root, gate, launches, sessionFile, run, spawn };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const chat = (id: string): string => `${JSON.stringify({ session_id: id })}\n`;

describe('a fork launch', () => {
  it('resumes the chat on a copy that is not saved', async () => {
    const { run, launches } = await setup([() => Promise.resolve(fakeChild([chat('fork-1')], 0))]);
    await run({ fork: true });
    const command = launches[0].command;
    expect(command.slice(command.indexOf('--resume'), command.indexOf('--resume') + 2)).toEqual(['--resume', 'chat-1']);
    expect(command).toEqual(expect.arrayContaining(['--fork-session', '--no-session-persistence']));
  });

  it('leaves the session file and the count of the launches of the step as they were', async () => {
    const { root, run, sessionFile } = await setup([() => Promise.resolve(fakeChild([chat('fork-1')], 0))]);
    const result = await run({ fork: true });
    expect(result.chatId).toBe('fork-1');
    expect(readFileSync(sessionFile, 'utf8')).toBe(SESSION);
    expect(existsSync(join(root, 'data', 'run1-implement-launches.txt'))).toBe(false);
  });

  it('takes no agent place, where a launch that is a visit takes one', async () => {
    let placed = -1;
    let forked = -1;
    const { gate, run } = await setup([
      () => {
        placed = gate.agentWait('run1').running;
        return Promise.resolve(fakeChild([chat('chat-1')], 0));
      },
      () => {
        forked = gate.agentWait('run1').running;
        return Promise.resolve(fakeChild([chat('fork-1')], 0));
      },
    ]);
    await run({});
    await run({ fork: true });
    expect([placed, forked]).toEqual([1, 0]);
  });

  it('waits while the server is paused, and goes on when it is resumed', async () => {
    const { gate, run, spawn } = await setup([() => Promise.resolve(fakeChild([chat('fork-1')], 0))]);
    gate.pause();
    const forked = run({ fork: true });
    await settle();
    expect(gate.running()).toBe(0);
    gate.resume();
    await forked;
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('is not launched again after a crash', async () => {
    const { run, spawn } = await setup([
      () => Promise.resolve(fakeChild([], 1)),
      () => Promise.resolve(fakeChild([chat('chat-1')], 0)),
    ]);
    const result = await run({ fork: true });
    expect(result.exitCode).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
