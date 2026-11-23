import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkOutputPath, readCheckOutput } from './check-output';
import { runFileOwner } from './run-files';

describe('check output files', () => {
  it('names the file from the run, step, attempt and command and keeps it in data', () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-check-output-'));
    expect(checkOutputPath(root, 'PROJ-1', 'checks', 'att-1', 3)).toBe(
      join(root, 'data', 'run-logs', 'PROJ-1', 'checks-att-1-command-3-log.txt'),
    );
    expect(runFileOwner('PROJ-1-checks-att-1-command-3-log.txt', new Set(['PROJ-1']))).toEqual({
      key: 'PROJ-1',
      kind: 'check-output',
    });
  });

  it('refuses a part that could leave data/', () => {
    for (const attempt of ['../x', 'a/b', 'a\\b']) {
      expect(() => checkOutputPath('/srv', 'PROJ-1', 'checks', attempt, 0)).toThrow('invalid');
    }
    expect(() => checkOutputPath('/srv', 'PROJ-1', 'checks', 'a', -1)).toThrow('invalid');
  });

  it('reads the file written at the check output path', () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-check-output-'));
    writeFileSync(checkOutputPath(root, 'PROJ-1', 'checks', 'att-1', 3), 'new\n');
    expect(readCheckOutput(root, 'PROJ-1', 'checks', 'att-1', 3)).toBe('new\n');
  });

  it('reads the flat file of a run written before the log folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-check-output-'));
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'PROJ-1-checks-att-1-command-3-log.txt'), 'old\n');
    expect(readCheckOutput(root, 'PROJ-1', 'checks', 'att-1', 3)).toBe('old\n');
  });

  it('returns null when neither file exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-check-output-'));
    expect(readCheckOutput(root, 'PROJ-1', 'checks', 'att-1', 3)).toBeNull();
  });
});
