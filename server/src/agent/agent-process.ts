import type { SandboxChild, SandboxService } from '../sandbox/sandbox.service';
import type { Clock } from '../core/clock';
import type { KillReason } from './limits';

const SAMPLE_MS = 5_000;

export interface AgentProcessHandlers {
  data(chunk: Buffer): void;
  error(chunk: Buffer): void;
  processError(error: NodeJS.ErrnoException): void;
  sample(): void;
  tick(): void;
}

export interface AgentProcessTimeouts {
  idleLimitMs: number;
  wallLimitMs: number;
  timeout(reason: Extract<KillReason, 'idle' | 'time'>): void;
}

/** One child process and its lifecycle. It deliberately knows nothing about agent runs or sessions. */
export class AgentProcess {
  private readonly earlyOut: Buffer[] = [];
  private readonly earlyErr: Buffer[] = [];
  private closedEarly: number | null = null;

  constructor(
    private readonly child: SandboxChild,
    private readonly sandbox: SandboxService,
    private readonly clock: Clock,
  ) {
    this.child.stdout?.on('data', this.keepOut);
    this.child.stderr?.on('data', this.keepErr);
    this.child.on('close', this.rememberClose);
  }

  static async spawn(
    sandbox: SandboxService,
    clock: Clock,
    launch: Parameters<SandboxService['spawn']>[0],
  ): Promise<AgentProcess> {
    return new AgentProcess(await sandbox.spawn(launch), sandbox, clock);
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
    let lastActivity = this.clock.now();
    const started = lastActivity;
    const data = (chunk: Buffer): void => {
      lastActivity = this.clock.now();
      handlers.data(chunk);
    };
    const error = (chunk: Buffer): void => {
      lastActivity = this.clock.now();
      handlers.error(chunk);
    };
    this.child.stdout?.on('data', data);
    this.child.stderr?.on('data', error);
    handlers.sample();
    const timer = setInterval(() => {
      const elapsed = this.clock.now() - started;
      const idle = this.clock.now() - lastActivity;
      handlers.sample();
      if (timeouts && elapsed >= timeouts.wallLimitMs) {
        timeouts.timeout('time');
      } else if (timeouts && idle >= timeouts.idleLimitMs) {
        timeouts.timeout('idle');
      } else {
        handlers.tick();
      }
    }, SAMPLE_MS);
    timer.unref();
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
      this.child.on('close', (code) => finish(code ?? 1));
      const watch = setInterval(() => {
        if (!shouldFinish()) {
          return;
        }
        clearInterval(watch);
        setTimeout(() => finish(1), 5_000).unref();
      }, 500);
      watch.unref();
    });
    this.child.stdout?.off('data', data);
    this.child.stderr?.off('data', error);
    clearInterval(timer);
    return exitCode;
  }

  private readonly keepOut = (chunk: Buffer): void => {
    this.earlyOut.push(chunk);
  };
  private readonly keepErr = (chunk: Buffer): void => {
    this.earlyErr.push(chunk);
  };
  private readonly rememberClose = (code: number | null): void => {
    this.closedEarly = code ?? 1;
  };
}
