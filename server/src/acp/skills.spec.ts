import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readCheckoutsRoot } from './skills';

function fileWith(...lines: string[]): string {
  const file = join(mkdtempSync(join(tmpdir(), 'swarmloop-skills-')), 'env');
  writeFileSync(file, [...lines, ''].join('\n'));
  return file;
}

describe('readCheckoutsRoot', () => {
  it('gives the default folder above for a missing file', () => {
    expect(readCheckoutsRoot(join(tmpdir(), 'swarmloop-skills-missing', 'env'), {})).toBe('..');
  });

  it('reads a value from the file, quoted or exported', () => {
    expect(readCheckoutsRoot(fileWith('CHECKOUTS_ROOT=/repos'), {})).toBe('/repos');
    expect(readCheckoutsRoot(fileWith('export CHECKOUTS_ROOT="/quoted"'), {})).toBe('/quoted');
  });

  it('keeps an explicit empty value as undefined', () => {
    expect(readCheckoutsRoot(fileWith('CHECKOUTS_ROOT='), {})).toBeUndefined();
    expect(readCheckoutsRoot(fileWith('CHECKOUTS_ROOT=/repos'), { CHECKOUTS_ROOT: '' })).toBeUndefined();
  });

  it('lets the environment win over the file', () => {
    expect(readCheckoutsRoot(fileWith('CHECKOUTS_ROOT=/file'), { CHECKOUTS_ROOT: '/env' })).toBe('/env');
  });
});
