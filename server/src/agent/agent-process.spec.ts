import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import type { SandboxChild, SandboxService } from '../sandbox/sandbox.service';
import { AgentProcess } from './agent-process';

describe('AgentProcess', () => {
  it('spawns the child through the sandbox', async () => {
    const child = fakeChild();
    const service = { spawn: jest.fn().mockResolvedValue(child) } as unknown as SandboxService;

    const process = await AgentProcess.spawn(service, new FakeClock(), {} as Parameters<SandboxService['spawn']>[0]);

    expect(service.spawn).toHaveBeenCalledWith({});
    expect(process.containerName).toBe('box');
  });

  it('resolves when the child exits cleanly', async () => {
    const child = fakeChild();
    const process = new AgentProcess(child as unknown as SandboxChild, sandbox(), new FakeClock());
    const waiting = process.wait(handlers(), () => false);
    child.emit('close', 0);
    await expect(waiting).resolves.toBe(0);
  });

  it('kills the child when the lifecycle reports an idle timeout', async () => {
    jest.useFakeTimers();
    try {
      const child = fakeChild();
      const clock = new FakeClock();
      const process = new AgentProcess(child as unknown as SandboxChild, sandbox(), clock);
      const timeout = jest.fn(() => process.kill());
      const waiting = process.wait(handlers(), () => false, { idleLimitMs: 1, wallLimitMs: 10, timeout });
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
      const process = new AgentProcess(child as unknown as SandboxChild, sandbox(), clock);
      const timeout = jest.fn(() => process.kill());
      const waiting = process.wait(handlers(), () => false, { idleLimitMs: 10, wallLimitMs: 1, timeout });
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
