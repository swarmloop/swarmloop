import { readableJobTrace } from './job-trace';

describe('readable job trace', () => {
  it('keeps elixir failures and the summary, and drops the compile log', () => {
    const noise = Array.from({ length: 400 }, (_, index) => `Compiling ${index} files (.ex)`).join('\n');
    const trace = [
      'trace truncated',
      noise,
      'section_start:123:step_script',
      '............',
      '  1) test saves a lot (App.LotTest)',
      '     test/lot_test.exs:12',
      '     Assertion with == failed',
      '     code:  assert Repo.get(Lot, 1) == nil',
      '     left:  %Lot{}',
      '     right: nil',
      '     stacktrace:',
      '       test/lot_test.exs:14: (test)',
      '',
      'Finished in 1.2 seconds (0.4s async, 0.8s sync)',
      '18 tests, 1 failure',
    ].join('\n');
    const body = readableJobTrace(trace);
    expect(body).toContain('1) test saves a lot');
    expect(body).toContain('Assertion with == failed');
    expect(body).toContain('18 tests, 1 failure');
    expect(body).not.toContain('Compiling');
    expect(body).not.toContain('section_start');
  });

  it('keeps a short trace as it is', () => {
    expect(readableJobTrace('log 7\n')).toBe('log 7');
  });

  it('ends a github log at the failed step and drops the timestamp', () => {
    const stamp = '2026-10-30T18:05:51.3865192Z ';
    const trace = [
      `${stamp}npm test`,
      `${stamp}Assertion failed`,
      `${stamp}##[error]Process completed with exit code 1.`,
      `${stamp}service container output`,
      `${stamp}Stop and remove container`,
    ].join('\n');
    const body = readableJobTrace(trace);
    expect(body).toContain('npm test');
    expect(body).toContain('Assertion failed');
    expect(body.endsWith('##[error]Process completed with exit code 1.')).toBe(true);
    expect(body).not.toContain(stamp.trim());
    expect(body).not.toContain('Stop and remove container');
    expect(body).not.toContain('service container output');
  });

  it('keeps the gitlab step script and drops the after script', () => {
    const trace = [
      'section_start:1:step_script',
      'unit failed in the job',
      'section_end:2:step_script',
      'section_start:3:after_script',
      'after script removed the database',
      'section_end:4:after_script',
    ].join('\n');
    const body = readableJobTrace(trace);
    expect(body).toContain('unit failed in the job');
    expect(body).not.toContain('after script removed the database');
    expect(body).not.toContain('section_end');
  });

  it('returns the last 200 lines when the log has no end marker', () => {
    const lines = Array.from({ length: 250 }, (_, index) => `plain line ${index}`);
    const body = readableJobTrace(lines.join('\n'));
    expect(body.split('\n')).toHaveLength(200);
    expect(body.startsWith('plain line 50\n')).toBe(true);
    expect(body.endsWith('plain line 249')).toBe(true);
    expect(body).not.toContain('plain line 49\n');
  });

  it('caps a trace at its last 20000 characters', () => {
    const trace = `${'x'.repeat(50000)}tail`;
    const body = readableJobTrace(trace);
    expect(body).toHaveLength(20000);
    expect(body.endsWith('tail')).toBe(true);
    expect(body.startsWith('x')).toBe(true);
  });
});
