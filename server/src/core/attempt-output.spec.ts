import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  attemptOutputPath,
  hasFinalResult,
  isOutputFileOf,
  outputFileFor,
  OutputFiles,
  stepOutput,
  stepOutputPath,
} from './attempt-output';

function rootWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'swarmloop-attempt-output-'));
  mkdirSync(join(root, 'data'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, 'data', name), body);
  return root;
}

describe('attempt output', () => {
  it('knows the output files of a run, for every output step', () => {
    expect(isOutputFileOf('K-1-plan-output.txt', 'K-1')).toBe(true);
    expect(isOutputFileOf('K-1-chat-abc-output.txt', 'K-1')).toBe(true);
    expect(isOutputFileOf('K-1-code-review-report-output.txt', 'K-1')).toBe(true);
    expect(isOutputFileOf('K-1-plan-output.txt', 'K-2')).toBe(false);
    expect(isOutputFileOf('swarmloop.sqlite', 'K-1')).toBe(false);
  });

  it("names the file of an attempt, and keeps today's name for a launch without one", () => {
    expect(outputFileFor('/r', 'K-1', 'implement', 'abc')).toBe(attemptOutputPath('/r', 'K-1', 'implement', 'abc'));
    expect(outputFileFor('/r', 'K-1', 'implement', 'abc')).toBe(join('/r', 'data', 'K-1-implement-abc-output.txt'));
    expect(outputFileFor('/r', 'K-1', 'implement', null)).toBe(join('/r', 'data', 'K-1-implement-output.txt'));
  });

  it('reads the file of the attempt first', () => {
    const root = rootWith({ 'K-1-implement-abc-output.txt': 'new\n', 'K-1-implement-output.txt': 'old\n' });
    expect(stepOutput(root, 'K-1', 'implement', 'abc')).toBe('new\n');
  });

  it('falls back to the name of older runs', () => {
    const root = rootWith({ 'K-1-implement-output.txt': 'old\n' });
    expect(stepOutput(root, 'K-1', 'implement', 'abc')).toBe('old\n');
    expect(stepOutput(root, 'K-1', 'plan', 'abc')).toBe('');
  });

  it('keeps the live log of the step and does not mix it with implement-improve', () => {
    const root = rootWith({
      'K-1-implement-abc-output.txt': 'one\n',
      'K-1-implement-improve-def-output.txt': 'two\n',
    });
    expect(stepOutput(root, 'K-1', 'implement', null)).toBe('one\n');
    expect(stepOutput(root, 'K-1', 'implement-improve', null)).toBe('two\n');
  });

  describe('OutputFiles', () => {
    it('reads the same outputs as the one-file helpers', () => {
      const root = rootWith({
        'K-1-implement-abc-output.txt': 'own\n',
        'K-1-plan-def-output.txt': 'newest\n',
        'K-1-research-output.txt': 'old\n',
      });
      const outputs = new OutputFiles(root);
      for (const [step, attempt] of [
        ['implement', 'abc'],
        ['plan', null],
        ['research', 'xyz'],
        ['commit', null],
      ] as const) {
        expect(outputs.path('K-1', step, attempt)).toBe(stepOutputPath(root, 'K-1', step, attempt));
        expect(outputs.read('K-1', step, attempt)).toBe(stepOutput(root, 'K-1', step, attempt));
      }
      expect(outputs.read('K-1', 'plan', null)).toBe('newest\n');
      expect(outputs.attemptIds('K-1', 'plan')).toEqual(['def']);
    });

    it('lists the data folder once for all lookups of one flow', () => {
      const root = rootWith({ 'K-1-plan-def-output.txt': 'a\n' });
      const outputs = new OutputFiles(root);
      expect(outputs.path('K-1', 'plan', null)).toBe(join(root, 'data', 'K-1-plan-def-output.txt'));
      writeFileSync(join(root, 'data', 'K-1-commit-ghi-output.txt'), 'b\n');
      expect(outputs.path('K-1', 'commit', null)).toBeNull();
      expect(stepOutputPath(root, 'K-1', 'commit', null)).toBe(join(root, 'data', 'K-1-commit-ghi-output.txt'));
    });
  });

  describe('stepOutput', () => {
    /** Ids sort opposite to age: 'zzz' is the older attempt, 'aaa' the newer one. */
    function twoAttempts(): string {
      const root = rootWith({ 'K-1-implement-zzz-output.txt': 'first\n', 'K-1-implement-aaa-output.txt': 'second\n' });
      utimesSync(join(root, 'data', 'K-1-implement-zzz-output.txt'), new Date(1000), new Date(1000));
      utimesSync(join(root, 'data', 'K-1-implement-aaa-output.txt'), new Date(2000), new Date(2000));
      return root;
    }

    it('reads the file of the attempt it is given', () => {
      const root = twoAttempts();
      expect(stepOutput(root, 'K-1', 'implement', 'zzz')).toBe('first\n');
      expect(stepOutput(root, 'K-1', 'implement', 'aaa')).toBe('second\n');
    });

    it('reads the newest attempt without an id, whatever the ids sort like', () => {
      expect(stepOutput(twoAttempts(), 'K-1', 'implement', null)).toBe('second\n');
    });

    it('does not take the file of another attempt for an id with no file', () => {
      expect(stepOutput(twoAttempts(), 'K-1', 'implement', 'missing')).toBe('');
    });

    it('does not take a sibling step, a launch record or a temp file for an attempt file', () => {
      const root = rootWith({
        'K-1-code-review-quality-abc-output.txt': 'quality\n',
        'K-1-code-review-launches.txt': '1\n',
        'K-1-code-review-abc-output.txt.1.tmp': 'half\n',
      });
      expect(stepOutput(root, 'K-1', 'code-review', null)).toBe('');
      expect(stepOutput(root, 'K-1', 'code-review-quality', null)).toBe('quality\n');
    });

    it('reads the single old-name file of a run from before attempts', () => {
      const root = rootWith({ 'K-1-implement-output.txt': 'old\n' });
      expect(stepOutput(root, 'K-1', 'implement', null)).toBe('old\n');
    });

    it('ignores the old-name file once the step has attempt files', () => {
      const root = rootWith({ 'K-1-implement-output.txt': 'old\n', 'K-1-implement-abc-output.txt': 'new\n' });
      expect(stepOutput(root, 'K-1', 'implement', null)).toBe('new\n');
    });
  });

  it('sees a final result line', () => {
    expect(hasFinalResult('x\n{"type":"result","subtype":"success"}\n')).toBe(true);
    expect(hasFinalResult('process started\n')).toBe(false);
  });
});
