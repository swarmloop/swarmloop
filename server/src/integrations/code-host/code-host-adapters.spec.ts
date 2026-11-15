import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { codeHostAdapters } from './code-host-adapters';

describe('code host adapters', () => {
  it('loads exactly the folders that hold an index module', () => {
    const folders = readdirSync(__dirname, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => ['index.ts', 'index.js'].some((file) => existsSync(join(__dirname, entry.name, file))))
      .map((entry) => entry.name)
      .sort();
    expect(codeHostAdapters().map((adapter) => adapter.name)).toEqual(folders);
    expect(folders).toEqual(['github', 'gitlab']);
  });

  it('tries gitlab before github when it builds a push url', () => {
    const ordered = [...codeHostAdapters()].sort((a, b) => a.pushOrder - b.pushOrder);
    expect(ordered.map((adapter) => adapter.name)).toEqual(['gitlab', 'github']);
  });

  it('creates repositories on github by default', () => {
    expect(
      codeHostAdapters()
        .filter((adapter) => adapter.createsByDefault)
        .map((adapter) => adapter.name),
    ).toEqual(['github']);
  });

  it('keeps the list it found', () => {
    expect(codeHostAdapters()).toBe(codeHostAdapters());
  });
});
