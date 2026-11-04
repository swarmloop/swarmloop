import { readFileSync } from 'fs';
import { join } from 'path';
import { replaceLogFile } from '../acp/live-output';
import type { Clock } from '../core/clock';
import { delay } from '../core/delay';
import type { LiveHub } from '../live/live.hub';
import type { VerifyOutputLine } from './verify.service';

const WRITE_EVERY_MS = 300;
const KEEP_BYTES = 500 * 1024;

export interface VerifyLogInput {
  live?: LiveHub;
  clock: Clock;
  root: string;
  key: string;
  label: string;
}

export interface VerifyLog {
  onOutput(line: VerifyOutputLine): void;
  /** Ends the run with `process exited <code>` and writes the file once more. Does nothing when no output came. */
  finish(code: number): Promise<void>;
}

/** The live log of the project checks: `data/<key>-verify-output.txt`, shown as the log of the `verify` step. */
export function createVerifyLog(input: VerifyLogInput): VerifyLog {
  const file = join(input.root, 'data', `${input.key}-verify-output.txt`);
  let body = readEarlier(file);
  let started = false;
  let closed = false;
  let waiting = false;
  let writtenAt = Number.NEGATIVE_INFINITY;
  let writing: Promise<void> = Promise.resolve();

  const write = (): Promise<void> => {
    writtenAt = input.clock.now();
    body = keepLast(body);
    const text = body;
    writing = writing.then(async () => {
      try {
        await replaceLogFile(file, text);
        input.live?.log({ key: input.key, step: 'verify', body: text });
      } catch {
        // A log that cannot be written must not stop the checks.
      }
    });
    return writing;
  };

  const add = (text: string): void => {
    body += `${text}\n`;
  };

  const schedule = (): void => {
    if (waiting || closed) {
      return;
    }
    const wait = WRITE_EVERY_MS - (input.clock.now() - writtenAt);
    if (wait <= 0) {
      void write();
      return;
    }
    waiting = true;
    void delay(wait).then(() => {
      waiting = false;
      if (!closed) {
        void write();
      }
    });
  };

  return {
    onOutput(line) {
      if (!started) {
        started = true;
        add(`== ${input.label} ==`);
      }
      add(line.text);
      schedule();
    },
    async finish(code) {
      if (!started || closed) {
        return;
      }
      closed = true;
      add(`process exited ${code}`);
      await write();
    },
  };
}

function readEarlier(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** The last 500 KB, starting at a whole line. */
function keepLast(text: string): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= KEEP_BYTES) {
    return text;
  }
  const tail = bytes.subarray(bytes.length - KEEP_BYTES).toString('utf8');
  return tail.slice(tail.indexOf('\n') + 1);
}
