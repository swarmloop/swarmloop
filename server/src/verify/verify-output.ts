export const TAIL_LINES = 150;
export const TAIL_CHARS = 12_000;

/** Splits a stream into lines. A partial last line comes out on flush. */
export class LineBuffer {
  private rest = '';

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Buffer | string): void {
    const parts = (this.rest + chunk.toString()).split('\n');
    this.rest = parts.pop() ?? '';
    for (const line of parts) {
      this.onLine(line.replace(/\r$/, ''));
    }
  }

  flush(): void {
    if (this.rest !== '') {
      this.onLine(this.rest);
      this.rest = '';
    }
  }
}

/** The last lines of a command's output, capped in lines and in characters. */
export class Tail {
  private lines: string[] = [];

  add(line: string): void {
    this.lines.push(line);
    if (this.lines.length > TAIL_LINES) {
      this.lines.shift();
    }
  }

  text(): string {
    return this.lines.join('\n').slice(-TAIL_CHARS);
  }
}
