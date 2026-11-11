import { mkdir, rename, writeFile } from 'fs/promises';
import { dirname } from 'path';
import type { SampleDraft } from '../history/visit';
import type { LiveHub } from '../live/live.hub';

let nextLogTemp = 0;

/** Whole body, then rename, so a reader never sees an empty or partial log. The temp name is not another output file. */
export async function replaceLogFile(destination: string, body: string): Promise<void> {
  const temporary = `${destination}.${++nextLogTemp}.tmp`;
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(temporary, body);
  await rename(temporary, destination);
}

export { liveLogFinished, logStillOpen } from '../core/live-output';

interface LogUsage {
  tokensIn: number;
  tokensOut: number;
  usd: number;
}

/** The log file and live view of one attempt: the baseline, then output and samples as they arrive. */
export class AttemptLog {
  readonly samples: SampleDraft[] = [];
  private output = '';
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly key: string,
    private readonly step: string,
    private readonly baseline: string,
    private readonly usage: () => LogUsage,
    private readonly live?: LiveHub,
  ) {}

  /** Writes the baseline to the file and tells the live view that the attempt has started. */
  async begin(): Promise<void> {
    await replaceLogFile(this.file, this.baseline);
    this.live?.changed(this.key);
    this.live?.log({
      key: this.key,
      step: this.step,
      body: this.baseline,
      samples: [],
      usage: { tokensIn: 0, tokensOut: 0, usd: 0 },
    });
  }

  note(chunk: string): void {
    if (this.closed) {
      return;
    }
    this.output += chunk;
    if (!this.publishTimer) {
      this.publishTimer = setTimeout(() => this.publish(), 80);
      this.publishTimer.unref();
    }
  }

  addSample(sample: SampleDraft): void {
    this.samples.push(sample);
  }

  publish(): void {
    this.publishTimer = null;
    const body = this.visible();
    if (!this.closed) {
      this.writing = this.writing.then(() => replaceLogFile(this.file, body)).catch(() => undefined);
    }
    this.live?.log({
      key: this.key,
      step: this.step,
      body: body === '' ? 'waiting for output\n' : body,
      samples: this.samples.map((sample) => ({
        at: sample.sampledAt,
        cpu: sample.cpuPercent,
        memory: sample.rssBytes,
        source: sample.source,
      })),
      usage: this.usage(),
    });
  }

  /** Stops new writes and waits for the ones already queued. */
  async close(): Promise<void> {
    this.closed = true;
    this.clearTimer();
    await this.writing;
  }

  /** Appends the ending line and returns the attempt output. The step result is already in memory, so a log flush that never calls back must not hold the step. */
  finish(ending: string): string {
    this.output = appendLine(this.output, ending);
    const body = this.visible();
    this.writing = this.writing.then(() => replaceLogFile(this.file, body)).catch(() => undefined);
    this.clearTimer();
    this.publish();
    return this.output;
  }

  private visible(): string {
    return `${this.baseline}${this.output}`;
  }

  private clearTimer(): void {
    if (this.publishTimer) {
      clearTimeout(this.publishTimer);
      this.publishTimer = null;
    }
  }
}

function appendLine(body: string, line: string): string {
  const base = body.length === 0 || body.endsWith('\n') ? body : `${body}\n`;
  return `${base}${line}\n`;
}
