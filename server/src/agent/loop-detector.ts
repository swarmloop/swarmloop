/** The part of an `agent.tool` event the detector reads. */
export interface ToolEvent {
  tool: string;
  target: string;
  status: 'ok' | 'failed' | 'unfinished';
  resultLine: string;
  errorLine?: string;
}

interface LoopVerdict {
  state: 'watching' | 'hint' | 'end';
  command: string;
  errorLine: string;
  /** The repeats seen so far in this loop, the ones before the hint included. */
  count: number;
}

const TAIL = /\s*2>&1\s*\|\s*tail\s+(?:-n\s*)?-?\d+\s*$/;

/** Whitespace collapsed and a trailing `2>&1 | tail -n N` dropped, so a rerun with another tail is the same command. */
export function normalizeCommand(target: string): string {
  return target.replace(TAIL, '').replace(/\s+/g, ' ').trim();
}

/**
 * A rule over the tool events of one step: the same shell command ending with the same exit code and the same first
 * error line `repeat` times in a row is a loop. The first time gives a hint, the same count again after it gives the end.
 * It reads tool events only: no model, network or database.
 */
export class LoopDetector {
  private key = '';
  private command = '';
  private errorLine = '';
  private count = 0;
  private total = 0;
  private hinted = false;
  private pendingState: 'hint' | 'end' | null = null;

  constructor(private readonly repeat: number) {}

  note(event: ToolEvent): LoopVerdict {
    if (event.status === 'unfinished') {
      // A background or killed task neither counts nor breaks a run of repeats.
      return this.verdict('watching');
    }
    if (event.tool !== 'shell' || event.status !== 'failed') {
      this.reset();
      return this.verdict('watching');
    }
    const command = normalizeCommand(event.target);
    const errorLine = event.errorLine ?? '';
    const key = `${command}\u0000${event.resultLine}\u0000${errorLine}`;
    if (key !== this.key) {
      this.reset();
      Object.assign(this, { key, command, errorLine });
    }
    this.count += 1;
    this.total += 1;
    if (this.count < this.repeat) {
      return this.verdict('watching');
    }
    this.count = 0;
    const state = this.hinted ? 'end' : 'hint';
    this.hinted = true;
    this.pendingState = state;
    return this.verdict(state);
  }

  /** The stop the detector asks for, until `resolveHint` takes it. */
  pending(): 'hint' | 'end' | null {
    return this.pendingState;
  }

  /** Takes a pending `hint`. Returns false for an `end`, which stays pending. */
  resolveHint(): boolean {
    if (this.pendingState !== 'hint') {
      return false;
    }
    this.pendingState = null;
    return true;
  }

  private reset(): void {
    Object.assign(this, { key: '', command: '', errorLine: '', count: 0, total: 0, hinted: false });
  }

  private verdict(state: LoopVerdict['state']): LoopVerdict {
    const count = state === 'watching' ? this.count : this.total;
    return { state, command: this.command, errorLine: this.errorLine, count };
  }
}
