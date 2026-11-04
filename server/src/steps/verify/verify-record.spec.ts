import { latestVerifyLog, machineLine, parseVerifyLog, renderVerifyLog, snapshotId } from './verify-record';

describe('verify_log', () => {
  it('keeps a passing run', () => {
    const body = renderVerifyLog(
      { result: 'pass', snapshot: 'abc', commands: ['npm ci', 'npm test'], exitCode: null, tail: '' },
      12_400,
    );
    expect(body).toBe('result: pass\nsnapshot: abc\nduration: 12s\ncommand: npm ci\ncommand: npm test\n');
    expect(parseVerifyLog(body)).toEqual({
      result: 'pass',
      snapshot: 'abc',
      commands: ['npm ci', 'npm test'],
      exitCode: null,
      tail: '',
    });
  });

  it('keeps a failed run with a tail that looks like the format', () => {
    const record = {
      result: 'fail' as const,
      snapshot: 'abc',
      commands: ['npm test'],
      exitCode: 2,
      tail: 'one\nexit: 5\ntail:\ntwo',
    };
    expect(parseVerifyLog(renderVerifyLog(record, 1000))).toEqual(record);
  });

  it('ignores a body that is not a verify_log', () => {
    expect(parseVerifyLog('nothing here\n')).toBeNull();
    expect(latestVerifyLog([{ kind: 'handoff', body: 'result: pass\nsnapshot: x\n' }])).toBeNull();
  });

  it('takes the latest verify_log and names the commands for reviewers', () => {
    const documents = [
      { kind: 'verify_log', body: 'result: fail\nsnapshot: a\nexit: 1\ntail:\nboom\n' },
      { kind: 'verify_log', body: 'result: pass\nsnapshot: b\ncommand: npm test\n' },
    ];
    expect(latestVerifyLog(documents)?.snapshot).toBe('b');
    expect(machineLine(['npm test', 'npm run lint'])).toBe(
      'Checked by machine on this exact tree: npm test, npm run lint. Do not re-check what these cover; look for what they cannot find.',
    );
    expect(snapshotId('x')).toBe(snapshotId('x'));
    expect(snapshotId('x')).not.toBe(snapshotId('y'));
  });
});
