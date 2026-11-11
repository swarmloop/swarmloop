import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : [path];
  });
}

describe('the dashboard serves no data folder', () => {
  it('has only the logo under public/', () => {
    expect(readdirSync(join(root, 'public'))).toEqual(['logo.svg']);
  });

  it('has no run-logs path in its code', () => {
    const files = [...sources(join(root, 'lib')), ...sources(join(root, 'features'))].filter(
      (file) => !file.endsWith('no-data-folder.test.ts'),
    );
    expect(files.filter((file) => readFileSync(file, 'utf8').includes('run-logs'))).toEqual([]);
  });
});
