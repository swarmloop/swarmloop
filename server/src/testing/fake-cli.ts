import { EventEmitter } from 'events';
import type { SandboxService } from '../sandbox/sandbox.service';

type Launch = Parameters<SandboxService['spawn']>[0];

/** A CLI in a container: its output arrives when a spec says so, and it ends when a spec ends it. */
class FakeCliChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  /** Everything written to stdin, and whether it was closed. */
  readonly written: string[] = [];
  stdinEnded = false;
  readonly stdin = {
    write: (text: string) => {
      this.written.push(text);
      return true;
    },
    end: () => {
      this.stdinEnded = true;
    },
  };

  constructor(readonly containerName: string) {
    super();
  }

  say(text: string): void {
    this.stdout.emit('data', Buffer.from(text));
  }

  complain(text: string): void {
    this.stderr.emit('data', Buffer.from(text));
  }

  exit(code: number): void {
    this.emit('close', code);
  }

  crash(message: string): void {
    this.emit('error', new Error(message));
  }
}

/** The part of `SandboxService` a CLI run uses, with the launches, the children and the removals recorded. */
export class FakeCliSandbox {
  readonly launches: Launch[] = [];
  readonly children: FakeCliChild[] = [];
  readonly removed: string[] = [];
  /** Set to make `spawn` fail, as a docker that does not answer does. */
  spawnError: Error | null = null;
  /** Plays a CLI that runs by itself once its caller listens: it says, complains and exits. */
  script: ((child: FakeCliChild, launch: Launch) => void) | null = null;

  spawn = (launch: Launch): Promise<FakeCliChild> => {
    if (this.spawnError) {
      return Promise.reject(this.spawnError);
    }
    this.launches.push(launch);
    const child = new FakeCliChild(`swarmloop-${launch.runKey}-${launch.step}`);
    this.children.push(child);
    setImmediate(() => this.script?.(child, launch));
    return Promise.resolve(child);
  };

  remove = (name: string): Promise<void> => {
    this.removed.push(name);
    return Promise.resolve();
  };
}
