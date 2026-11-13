import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readShellConfig } from './shell-env';

function configWith(...lines: string[]) {
  const file = join(mkdtempSync(join(tmpdir(), 'swarmloop-shell-env-')), 'env');
  writeFileSync(file, ['AGENTS_IMPLEMENT=cursor:from-env', ...lines, ''].join('\n'));
  return readShellConfig(file);
}

describe('shell config reserve', () => {
  it('defaults to 2 GB without the line, and for a value that is not a number of 0 or more', () => {
    expect(configWith().reserveMemoryGb).toBe(2);
    expect(configWith('RESERVE_MEMORY_GB=lots').reserveMemoryGb).toBe(2);
    expect(configWith('RESERVE_MEMORY_GB=-1').reserveMemoryGb).toBe(2);
    expect(configWith('RESERVE_MEMORY_GB=').reserveMemoryGb).toBe(2);
  });

  it('reads the reserve as the server does', () => {
    expect(configWith('RESERVE_MEMORY_GB=4').reserveMemoryGb).toBe(4);
    expect(configWith('RESERVE_MEMORY_GB=0').reserveMemoryGb).toBe(0);
  });
});
