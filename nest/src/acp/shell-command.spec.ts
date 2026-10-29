import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { hostCheckout } from './paths';
import { parseShell, pickSnapshot } from './shell-command';
import { readShellConfig } from './shell-env';
import { matchFeatures } from '../api/shell.service';

describe('parseShell', () => {
  const keys = ['PROJ-1'];

  it('keeps vendor words and reserved feature commands apart', () => {
    expect(parseShell([], keys)).toEqual({ type: 'attach', key: null, vendor: [] });
    expect(parseShell(['mcp', 'list'], keys)).toEqual({ type: 'attach', key: null, vendor: ['mcp', 'list'] });
    expect(parseShell(['PROJ-1', 'mcp', 'list'], keys)).toEqual({ type: 'attach', key: 'PROJ-1', vendor: ['mcp', 'list'] });
    expect(parseShell(['rewind', '--to', '4'], keys)).toEqual({ type: 'rewind', key: null, to: '4' });
    expect(parseShell(['step', 'commit', 'check', 'the', 'form'], keys)).toEqual({
      type: 'step',
      key: null,
      step: 'commit',
      prompt: 'check the form',
    });
    expect(parseShell(['replay', 'start', 'again'], keys)).toEqual({ type: 'replay', key: null, prompt: 'start again' });
    expect(parseShell(['review', '/tmp/demo', 'look'], keys)).toEqual({ type: 'review', path: '/tmp/demo', prompt: 'look' });
    expect(parseShell(['rewind'], ['rewind'])).toEqual({ type: 'attach', key: 'rewind', vendor: [] });
    expect(pickSnapshot([{ id: 4 }, { id: 9 }], '9')).toBe(9);
    expect(pickSnapshot([{ id: 4 }, { id: 9 }], '1')).toBeNull();
  });
});

describe('host checkout', () => {
  it('maps nest paths back to the host', () => {
    expect(hostCheckout('/checkouts/demo', '/tmp/swarmloop', '/tmp/outside')).toBe('/tmp/outside/demo');
    expect(hostCheckout('/app/worktrees/PROJ-1', '/tmp/swarmloop', '/tmp/outside')).toBe('/tmp/swarmloop/worktrees/PROJ-1');
    expect(hostCheckout('/tmp/already', '/tmp/swarmloop', '/tmp/outside')).toBe('/tmp/already');
  });
});

describe('shell config', () => {
  it('reads the runtime and the implement model', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarmloop-env-'));
    const file = join(dir, 'env');
    writeFileSync(file, 'RUNTIME=cursor\nMODEL_IMPLEMENT=from-env\nCURSOR_API_KEY=dummy\n');
    const config = readShellConfig(file);
    expect(config.runtime).toBe('cursor');
    expect(config.model).toBe('from-env');
    expect(config.cursorKey).toBe('dummy');
  });
});

describe('feature match', () => {
  it('matches one directory and lists several', () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-features-'));
    const alpha = join(root, 'alpha');
    const beta = join(root, 'beta');
    const nested = join(alpha, 'nested');
    mkdirSync(nested, { recursive: true });
    mkdirSync(beta);
    const runs = [
      { key: 'PROJ-1', targetPath: alpha },
      { key: 'PROJ-2', targetPath: beta },
    ];
    expect(matchFeatures(runs, alpha, root).map((run) => run.key)).toEqual(['PROJ-1']);
    expect(matchFeatures(runs, beta, root).map((run) => run.key)).toEqual(['PROJ-2']);
    const both = [
      { key: 'PROJ-1', targetPath: alpha },
      { key: 'PROJ-3', targetPath: nested },
    ];
    expect(matchFeatures(both, nested, root).map((run) => run.key)).toEqual(['PROJ-1', 'PROJ-3']);
  });
});
