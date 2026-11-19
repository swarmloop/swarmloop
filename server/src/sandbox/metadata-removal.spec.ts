import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { MetadataRemoval } from './metadata-removal';

describe('MetadataRemoval', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'metadata-removal-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('returns before the removal ends and leaves the directory gone after drained()', async () => {
    const copy = join(directory, 'git-metadata');
    mkdirSync(join(copy, 'objects'), { recursive: true });
    writeFileSync(join(copy, 'objects', 'pack'), 'x');
    const removal = new MetadataRemoval();
    removal.remove([copy]);
    expect(existsSync(copy)).toBe(true);
    await removal.drained();
    expect(existsSync(copy)).toBe(false);
  });

  it('logs a failure with the path and does not throw', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const file = join(directory, 'file');
      writeFileSync(file, 'x');
      const removal = new MetadataRemoval();
      removal.remove([join(file, 'inside', 'deeper\0bad')]);
      await expect(removal.drained()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('deeper'));
    } finally {
      warn.mockRestore();
    }
  });
});
