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

    const process = await AgentProcess.spawn(service, {} as Parameters<SandboxService['spawn']>[0]);

    expect(spawn).toHaveBeenCalledWith({});
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

  it('does not kill a step for time the host slept and reports the suspension once', async () => {
    jest.useFakeTimers();
    try {
      const child = fakeChild();
      const clock = new FakeClock();
      const suspended = jest.fn();
      const time = new AwakeTime(clock, 5_000, suspended);
      const process = new AgentProcess(child as unknown as SandboxChild, sandbox());
      const timeout = jest.fn(() => process.kill());
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
      expect(timeout).not.toHaveBeenCalled();
      expect(suspended).toHaveBeenCalledTimes(1);
      expect(suspended).toHaveBeenCalledWith(40 * 60_000);
      awake(19);
      expect(timeout).not.toHaveBeenCalled();
      awake(1);
      expect(timeout).toHaveBeenCalledWith('time');
      child.emit('close', 1);
      await waiting;
    } finally {
      jest.useRealTimers();
    }
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
