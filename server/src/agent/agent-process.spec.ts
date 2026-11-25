import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { AwakeTime } from '../core/awake-time';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import type { SandboxChild, SandboxService } from '../sandbox/sandbox.service';
import { AgentProcess } from './agent-process';

describe('AgentProcess', () => {
  it('spawns the child through the sandbox', async () => {
    const child = fakeChild();
    const spawn = jest.fn().mockResolvedValue(child);
    const service = { spawn } as unknown as SandboxService;

    const held = { onPaused: jest.fn() };
    const process = await AgentProcess.spawn(service, {} as Parameters<SandboxService['spawn']>[0], held);

    expect(spawn).toHaveBeenCalledWith({}, held);
    expect(process.containerName).toBe('box');
  });

  it('resolves when the child exits cleanly', async () => {
    const child = fakeChild();
    const process = new AgentProcess(child as unknown as SandboxChild, sandbox());
    const waiting = process.wait(handlers(), () => false);
    child.emit('close', 0);
    await expect(waiting).resolves.toBe(0);
  });

  it('kills the child when the lifecycle reports an idle timeout', async () => {
    jest.useFakeTimers();
    try {
      const child = fakeChild();
      const clock = new FakeClock();
      const process = new AgentProcess(child as unknown as SandboxChild, sandbox());
      const timeout = jest.fn(() => process.kill());
      const waiting = process.wait(handlers(), () => false, {
        time: new AwakeTime(clock, 5_000),
        idleLimitMs: 1,
        wallLimitMs: 10,
        timeout,
      });
      clock.advance(1);
      jest.advanceTimersByTime(5_000);
      expect(timeout).toHaveBeenCalledWith('idle');
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      child.emit('close', 1);
      await expect(waiting).resolves.toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('kills the child when the lifecycle reports a wall timeout', async () => {
    jest.useFakeTimers();
    try {
      const child = fakeChild();
      const clock = new FakeClock();
      const process = new AgentProcess(child as unknown as SandboxChild, sandbox());
      const timeout = jest.fn(() => process.kill());
      const waiting = process.wait(handlers(), () => false, {
        time: new AwakeTime(clock, 5_000),
        idleLimitMs: 10,
        wallLimitMs: 1,
        timeout,
      });
      clock.advance(1);
      jest.advanceTimersByTime(5_000);
      expect(timeout).toHaveBeenCalledWith('time');
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      child.emit('close', 1);
      await expect(waiting).resolves.toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not kill a step for time the host slept', async () => {
    jest.useFakeTimers();
    try {
      const child = fakeChild();
      const clock = new FakeClock();
      const time = new AwakeTime(clock, 5_000);
      const process = new AgentProcess(child as unknown as SandboxChild, sandbox());
      const timeouts: string[] = [];
      const timeout = (reason: 'idle' | 'time') => {
        timeouts.push(reason);
        process.kill();
      };
      const waiting = process.wait(handlers(), () => false, {
        time,
        idleLimitMs: 60 * 60_000,
        wallLimitMs: 30 * 60_000,
        timeout,
      });
      const awake = (minutes: number): void => {
        for (let sample = 0; sample < minutes * 12; sample += 1) {
          clock.advance(5_000);
          jest.advanceTimersByTime(5_000);
        }
      };
      awake(10);
      clock.advance(40 * 60_000);
      jest.advanceTimersByTime(5_000);
      expect(timeouts).toEqual([]);
      awake(19);
      expect(timeouts).toEqual([]);
      awake(1);
      expect(timeouts).toEqual(['time']);
      child.emit('close', 1);
      await waiting;
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('AgentProcess end', () => {
  it('kills the container and the docker client of a child that has not closed, and waits for its close', async () => {
    const child = fakeChild();
    child.kill.mockImplementation(
      (signal: string) => signal === 'SIGKILL' && setImmediate(() => child.emit('close', 137)),
    );
    const kill = jest.fn().mockResolvedValue(undefined);
    const process = new AgentProcess(child as unknown as SandboxChild, { kill } as unknown as SandboxService);
    await process.end();
    expect(kill).toHaveBeenCalledWith('box');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it.each(['close', 'error'])('leaves a child that already ended with %s alone', async (event) => {
    const child = fakeChild();
    const kill = jest.fn().mockResolvedValue(undefined);
    const process = new AgentProcess(child as unknown as SandboxChild, { kill } as unknown as SandboxService);
    child.emit(event, event === 'close' ? 0 : new Error('gone'));
    await process.end();
    expect(kill).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });
});

function fakeChild(): EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  containerName: string;
  kill: jest.Mock;
} {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    containerName: 'box',
    kill: jest.fn(),
  });
}

function sandbox(): SandboxService {
  return { kill: jest.fn().mockResolvedValue(undefined) } as unknown as SandboxService;
}

function handlers() {
  return {
    data: jest.fn(),
    error: jest.fn(),
    processError: jest.fn(),
    sample: jest.fn(),
    tick: jest.fn(),
  };
}
