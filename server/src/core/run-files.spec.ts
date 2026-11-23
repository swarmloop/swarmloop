import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, basename } from 'path';
import { attemptOutputPath, outputFileFor } from './attempt-output';
import { listRunEntries, OUTPUT_STEPS, runFileName, runFileOwner } from './run-files';

describe('run files', () => {
  it('matches every file name the writers produce for a run', () => {
    for (const key of ['PROJ-1', 'PROJ-1-a']) {
      const keys = new Set([key]);
      const names: [string, string][] = [['output', basename(outputFileFor('/r', key, 'plan', null))]];
      for (const step of OUTPUT_STEPS) {
        names.push(
          ['output', basename(attemptOutputPath('/r', key, step, 'att-1'))],
          ['output', basename(outputFileFor('/r', key, step, null))],
          ['output', basename(outputFileFor('/r', key, step, '1f2e-3d4c'))],
          ['launches', runFileName(key, step, 'launches')],
          ['session', runFileName(key, step, 'session')],
        );
      }
      names.push(
        ['output', runFileName(key, 'setup', 'output')],
        ['output', `${key}-demo-setup-output.txt`],
        ['check-output', runFileName(key, 'checks-att-1-command-3', 'check-output')],
      );
      for (const [kind, name] of names) {
        expect([name, runFileOwner(name, keys)]).toEqual([name, { key, kind }]);
      }
      expect(runFileOwner(`run-logs/${key}`, keys)).toEqual({ key, kind: 'logs' });
    }
  });

  it("keeps a file of a subtask whose key begins with its epic's with the subtask", () => {
    const keys = new Set(['PROJ-1', 'PROJ-1-a']);
    for (const name of [
      'PROJ-1-a-implement-abc-output.txt',
      'PROJ-1-a-setup-output.txt',
      'PROJ-1-a-plan-session.json',
      'PROJ-1-a-plan-launches.txt',
      'PROJ-1-a-checks-att-command-0-log.txt',
      'run-logs/PROJ-1-a',
    ]) {
      expect([name, runFileOwner(name, keys)?.key]).toEqual([name, 'PROJ-1-a']);
    }
    expect(runFileOwner('PROJ-1-implement-abc-output.txt', keys)?.key).toBe('PROJ-1');
    expect(runFileOwner('PROJ-1-a-setup-output.txt', new Set(['PROJ-1']))?.key).toBe('PROJ-1');
  });

  it('leaves shared names and later sessions to no run', () => {
    const keys = new Set(['agent', 'swarmloop', 'price', 'PROJ-1']);
    for (const name of [
      'agent-state',
      'swarmloop-empty-env',
      'price-cache-x.json',
      'swarmloop.sqlite',
      'run-logs',
      'PROJ-1--2-plan-session.json',
    ]) {
      expect([name, runFileOwner(name, keys)]).toEqual([name, null]);
    }
    expect(runFileOwner('PROJ-1--2-plan-session.json', new Set(['PROJ-1--2']))).toEqual({
      key: 'PROJ-1--2',
      kind: 'session',
    });
  });

  it('lists the data names and the log folders, and none for a missing data folder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-run-entries-'));
    expect(await listRunEntries(root)).toEqual([]);
    mkdirSync(join(root, 'data', 'run-logs', 'PROJ-1'), { recursive: true });
    writeFileSync(join(root, 'data', 'PROJ-1-plan-output.txt'), 'x');
    expect((await listRunEntries(root)).sort()).toEqual(['PROJ-1-plan-output.txt', 'run-logs', 'run-logs/PROJ-1']);
  });
});
