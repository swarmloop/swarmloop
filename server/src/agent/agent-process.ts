import { constants } from 'os';
import type { SandboxChild, SandboxService } from '../sandbox/sandbox.service';
import { markedInterval } from '../core/entered-marks';
import type { AwakeTime } from '../core/awake-time';
import { SAMPLE_MS } from '../core/awake-time';
import type { KillReason } from './limits';

interface AgentProcessHandlers {
  data(chunk: Buffer): void;
  error(chunk: Buffer): void;
  processError(error: NodeJS.ErrnoException): void;
  sample(): void;
  tick(): void;
}

interface AgentProcessTimeouts {
  /** Awake time of this launch. Output touches it before it reaches the handlers. */
  time: AwakeTime;
  idleLimitMs: number;
  wallLimitMs: number;
  timeout(reason: Extract<KillReason, 'idle' | 'time'>): void;
}

/** The exit code of a close: a child ended by a signal gives 128 plus its number, as a shell reads it. */
function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  return signal ? 128 + constants.signals[signal] : 1;
}

/** One child process and its lifecycle. It deliberately knows nothing about agent runs or sessions. */
export class AgentProcess {
  private readonly earlyOut: Buffer[] = [];
  private readonly earlyErr: Buffer[] = [];
  private closedEarly: number | null = null;
  private ended = false;

  constructor(
    private readonly child: SandboxChild,
    private readonly sandbox: SandboxService,
  ) {
    this.child.stdout?.on('data', this.keepOut);
    this.child.stderr?.on('data', this.keepErr);
    this.child.on('close', this.rememberClose);
    this.child.on('close', this.markEnded);
    this.child.on('error', this.markEnded);
  }

  static async spawn(
    sandbox: SandboxService,
    launch: Parameters<SandboxService['spawn']>[0],
    held?: Parameters<SandboxService['spawn']>[1],
  ): Promise<AgentProcess> {
    return new AgentProcess(await sandbox.spawn(launch, held), sandbox);
  }

  get containerName(): string {
    return this.child.containerName;
  }

  kill(force = true): void {
    this.child.kill('SIGTERM');
    void this.sandbox.kill(this.child.containerName);
    if (force) {
      setTimeout(() => this.child.kill('SIGKILL'), 2000).unref();
    }
  }

  /**
   * Ends the container of a launch that is over, so its agent place comes back. A child that has closed or died is left alone.
   * One that has not (a CLI as PID 1 ignores SIGTERM) loses its container and its docker client, and its close is awaited.
   */
  async end(): Promise<void> {
    if (this.ended) {
      return;
    }
    const closed = new Promise<void>((resolve) => this.child.once('close', () => resolve()));
    await this.sandbox.kill(this.child.containerName);
    this.child.kill('SIGKILL');
    await closed;
  }

  async wait(
    handlers: AgentProcessHandlers,
    shouldFinish: () => boolean,
    timeouts?: AgentProcessTimeouts,
  ): Promise<number> {
    this.child.stdout?.off('data', this.keepOut);
    this.child.stderr?.off('data', this.keepErr);
    this.child.off('close', this.rememberClose);
    for (const chunk of this.earlyOut) {
      handlers.data(chunk);
    }
    for (const chunk of this.earlyErr) {
      handlers.error(chunk);
    }
    const data = (chunk: Buffer): void => handlers.data(chunk);
    const error = (chunk: Buffer): void => handlers.error(chunk);
    this.child.stdout?.on('data', data);
    this.child.stderr?.on('data', error);
    handlers.sample();
    const timer = markedInterval(
      'agent sample',
      () => {
        handlers.sample();
        if (timeouts && timeouts.time.elapsedMs() >= timeouts.wallLimitMs) {
          timeouts.timeout('time');
        } else if (timeouts && timeouts.time.idleMs() >= timeouts.idleLimitMs) {
          timeouts.timeout('idle');
        } else {
          handlers.tick();
        }
      },
      SAMPLE_MS,
    );
    const exitCode = await new Promise<number>((resolve) => {
      let settled = false;
      const finish = (code: number): void => {
        if (!settled) {
          settled = true;
          resolve(code);
        }
      };
      this.child.on('error', (error: NodeJS.ErrnoException) => {
        handlers.processError(error);
        finish(1);
      });
      if (this.closedEarly !== null) {
        finish(this.closedEarly);
      }
      this.child.on('close', (code, signal) => finish(exitCodeOf(code, signal)));
      const watch = markedInterval(
        'agent watch',
        () => {
          if (!shouldFinish()) {
            return;
          }
          clearInterval(watch);
          setTimeout(() => finish(1), 5_000).unref();
        },
        500,
      );
    });
    this.child.stdout?.off('data', data);
    this.child.stderr?.off('data', error);
    clearInterval(timer);
    return exitCode;
  }

  private readonly markEnded = (): void => {
    this.ended = true;
  };
  private readonly keepOut = (chunk: Buffer): void => {
    this.earlyOut.push(chunk);
  };
  private readonly keepErr = (chunk: Buffer): void => {
    this.earlyErr.push(chunk);
  };
  private readonly rememberClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    this.closedEarly = exitCodeOf(code, signal);
  };
}
