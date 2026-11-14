import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readApiUrl, readShellConfig } from './shell-env';

function fileWith(...lines: string[]): string {
  const file = join(mkdtempSync(join(tmpdir(), 'swarmloop-shell-env-')), 'env');
  writeFileSync(file, [...lines, ''].join('\n'));
  return file;
}

function configWith(...lines: string[]) {
  return readShellConfig(fileWith('AGENTS_IMPLEMENT=cursor:from-env', ...lines), {});
}

describe('shell API address', () => {
  it('reads the address in the order environment, file, defaults.env', () => {
    const file = fileWith('SWARMLOOP_API_URL=http://from-file:3920');
    expect(readApiUrl(file, { SWARMLOOP_API_URL: 'http://from-env:3920' })).toBe('http://from-env:3920');
    expect(readApiUrl(file, {})).toBe('http://from-file:3920');
    expect(readApiUrl(join(tmpdir(), 'swarmloop-shell-env-missing', 'env'), {})).toBe('http://127.0.0.1:3920');
  });
});

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

describe('shell config precedence', () => {
  it('lets the environment win over the file, and the file over defaults.env', () => {
    const file = fileWith('RESERVE_MEMORY_GB=4', 'SANDBOX_DOCKER_RUNTIME=runsc', 'CURSOR_API_KEY=from-file');
    expect(readShellConfig(file, { RESERVE_MEMORY_GB: '6' }).reserveMemoryGb).toBe(6);
    expect(readShellConfig(file, {}).reserveMemoryGb).toBe(4);
    expect(readShellConfig(file, { SANDBOX_DOCKER_RUNTIME: 'kata' }).engine).toBe('kata');
    expect(readShellConfig(file, {}).engine).toBe('runsc');
    expect(readShellConfig(file, { CURSOR_API_KEY: 'from-env' }).cursorKey).toBe('from-env');
    expect(readShellConfig(file, {}).cursorKey).toBe('from-file');
  });

  it('uses the defaults for a missing file', () => {
    const config = readShellConfig(join(tmpdir(), 'swarmloop-shell-env-missing', 'env'), {});
    expect(config.runtime).toBe('claude');
    expect(config.checkoutsRoot).toBe('..');
    expect(config.reserveMemoryGb).toBe(2);
  });

  it('lets an explicit empty win over the file and the defaults', () => {
    expect(configWith('CHECKOUTS_ROOT=').checkoutsRoot).toBe('');
    expect(readShellConfig(fileWith('CHECKOUTS_ROOT=/x'), { CHECKOUTS_ROOT: '' }).checkoutsRoot).toBe('');
    expect(() => readShellConfig(fileWith('AGENTS_IMPLEMENT='), {})).toThrow('AGENTS_IMPLEMENT is missing or invalid');
    expect(() => readShellConfig(fileWith('AGENTS_IMPLEMENT=cursor:x'), { AGENTS_IMPLEMENT: '' })).toThrow(
      'AGENTS_IMPLEMENT is missing or invalid',
    );
  });

  it('reads quoted and exported entries', () => {
    const config = configWith(
      'export CURSOR_API_KEY="quoted key"',
      "ANTHROPIC_API_KEY='single'",
      'export CHECKOUTS_ROOT=/repos',
    );
    expect(config).toMatchObject({ cursorKey: 'quoted key', anthropicKey: 'single', checkoutsRoot: '/repos' });
  });
});
