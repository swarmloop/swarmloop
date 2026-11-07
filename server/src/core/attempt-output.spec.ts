import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { liveLogBody } from './live-output';
import { attemptOutputPath, hasFinalResult, outputFileFor, readAttemptOutput } from './attempt-output';

function rootWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'swarmloop-attempt-output-'));
  mkdirSync(join(root, 'data'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, 'data', name), body);
  return root;
}

describe('attempt output', () => {
  it("names the file of an attempt, and keeps today's name for a launch without one", () => {
    expect(outputFileFor('/r', 'K-1', 'implement', 'abc')).toBe(attemptOutputPath('/r', 'K-1', 'implement', 'abc'));
    expect(outputFileFor('/r', 'K-1', 'implement', 'abc')).toBe(join('/r', 'data', 'K-1-implement-abc-output.txt'));
    expect(outputFileFor('/r', 'K-1', 'implement', null)).toBe(join('/r', 'data', 'K-1-implement-output.txt'));
  });

  it('reads the file of the attempt first', () => {
    const root = rootWith({ 'K-1-implement-abc-output.txt': 'new\n', 'K-1-implement-output.txt': 'old\n' });
    expect(readAttemptOutput(root, 'K-1', 'implement', 'abc')).toBe('new\n');
  });

  it('falls back to the name of older runs', () => {
    const root = rootWith({ 'K-1-implement-output.txt': 'old\n' });
    expect(readAttemptOutput(root, 'K-1', 'implement', 'abc')).toBe('old\n');
    expect(readAttemptOutput(root, 'K-1', 'plan', 'abc')).toBe('');
  });

  it('keeps the live log of the step and does not mix it with implement-improve', () => {
    const root = rootWith({
      'K-1-implement-abc-output.txt': 'one\n',
      'K-1-implement-improve-def-output.txt': 'two\n',
    });
    expect(liveLogBody(root, 'K-1', 'implement')).toBe('one\n');
    expect(liveLogBody(root, 'K-1', 'implement-improve')).toBe('two\n');
  });

  it('sees a final result line', () => {
    expect(hasFinalResult('x\n{"type":"result","subtype":"success"}\n')).toBe(true);
    expect(hasFinalResult('process started\n')).toBe(false);
  });
});
