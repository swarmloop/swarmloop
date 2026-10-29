import { Injectable } from '@nestjs/common';
import { createInterface } from 'readline';
import { PasteNeeded } from '../swarmloop-error';
import { PasteReader } from './tokens';

@Injectable()
export class TerminalPasteReader implements PasteReader {
  async read(url: string): Promise<string> {
    if (!process.stdin.isTTY) {
      throw new PasteNeeded(url);
    }
    process.stdout.write(`Paste the body for ${url}\nFinish with a line that contains only a dot.\n`);
    const lines: string[] = [];
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    for await (const line of reader) {
      if (line === '.') {
        break;
      }
      lines.push(line);
    }
    reader.close();
    return lines.join('\n');
  }
}
