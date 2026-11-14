import { existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { markedTail, RUN_LOGS_PATH, runLogContainerPath, runLogDir, runLogMount, runLogPath } from './run-logs';

const root = () => mkdtempSync(join(tmpdir(), 'swarmloop-run-logs-'));

describe('run logs', () => {
  it('names a file inside the run folder and creates the folder', () => {
    const base = root();
    const file = runLogPath(base, 'PROJ-1', 'checks-a-command-0');
    expect(file).toBe(join(base, 'data', 'run-logs', 'PROJ-1', 'checks-a-command-0-log.txt'));
    expect(existsSync(join(base, 'data', 'run-logs', 'PROJ-1'))).toBe(true);
  });

  it('refuses a key or name that could leave the folder', () => {
    const base = root();
    for (const bad of ['../x', 'a/b', 'a\\b']) {
      expect(() => runLogDir(base, bad)).toThrow('invalid');
      expect(() => runLogPath(base, bad, 'x')).toThrow('invalid');
      expect(() => runLogPath(base, 'PROJ-1', bad)).toThrow('invalid');
    }
    expect(() => runLogDir(base, '')).toThrow('invalid');
  });

  it('names the path of a log inside the sandbox', () => {
    expect(RUN_LOGS_PATH).toBe('/work/logs');
    expect(runLogContainerPath('/any/dir/x-log.txt')).toBe('/work/logs/x-log.txt');
  });

  it('mounts the run folder read-only', () => {
    const base = root();
    expect(runLogMount(base, 'PROJ-1')).toEqual({
      hostPath: join(base, 'data', 'run-logs', 'PROJ-1'),
      containerPath: '/work/logs',
      readonly: true,
    });
    expect(existsSync(join(base, 'data', 'run-logs', 'PROJ-1'))).toBe(true);
  });

  describe('markedTail', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);

    it('puts the mark before the kept end when lines were left out', () => {
      expect(markedTail(lines, 500, 80, 6000, '/d/run-logs/r/x-log.txt')).toBe(
        `… 420 earlier lines not shown; the whole output: /work/logs/x-log.txt\n${lines.slice(-80).join('\n')}`,
      );
    });

    it('counts a line cut by the character limit as shown', () => {
      const tail = markedTail(lines, 500, 80, 100, '/d/x-log.txt');
      const kept = lines.slice(-80).join('\n').slice(-100);
      const shown = kept.split('\n').length;
      expect(tail).toBe(`… ${500 - shown} earlier lines not shown; the whole output: /work/logs/x-log.txt\n${kept}`);
    });

    it('adds no mark when nothing was cut', () => {
      expect(markedTail(lines.slice(0, 10), 10, 80, 6000, '/d/x-log.txt')).toBe(lines.slice(0, 10).join('\n'));
    });
  });
});
