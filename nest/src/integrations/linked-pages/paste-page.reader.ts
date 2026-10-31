import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createInterface } from 'readline';
import { Repository } from 'typeorm';
import { PasteEntity } from '../../history/entities';
import { PasteNeeded } from '../../swarmloop-error';

export const PASTE_READER = Symbol('PASTE_READER');

export interface PasteReader {
  read(url: string): Promise<string>;
}

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

@Injectable()
export class PastePageReader {
  constructor(
    @InjectRepository(PasteEntity) private readonly pasteRows: Repository<PasteEntity>,
    @Inject(PASTE_READER) private readonly reader: PasteReader,
  ) {}

  async savedPastes(runKey: string): Promise<Record<string, string>> {
    const rows = await this.pasteRows.find({ where: { runKey } });
    const stored: Record<string, string> = {};
    for (const row of rows) {
      stored[row.url] = row.body;
    }
    return stored;
  }

  async rememberPaste(runKey: string, url: string, body: string): Promise<void> {
    const existing = await this.pasteRows.findOne({ where: { runKey, url } });
    if (existing) {
      existing.body = body;
      await this.pasteRows.save(existing);
      return;
    }
    await this.pasteRows.save(this.pasteRows.create({ runKey, url, body }));
  }

  read(url: string): Promise<string> {
    return this.reader.read(url);
  }
}
