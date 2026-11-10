import { LoopDetector, normalizeCommand } from './loop-detector';
import type { ToolEvent } from './loop-detector';

function shell(target: string, errorLine = 'Cannot find module x', exit = 1): ToolEvent {
  return { tool: 'shell', target, status: 'failed', resultLine: `exit ${exit}`, errorLine };
}

const passing: ToolEvent = { tool: 'shell', target: 'npm test', status: 'ok', resultLine: 'exit 0' };

/** Feeds a recorded stream and returns the state after each event. */
function replay(detector: LoopDetector, events: ToolEvent[]): string[] {
  return events.map((event) => detector.note(event).state);
}

function times(count: number, event: ToolEvent): ToolEvent[] {
  return Array.from({ length: count }, () => event);
}

describe('LoopDetector', () => {
  it('gives one hint for four identical failing runs and the end for four more', () => {
    const detector = new LoopDetector(4);
    const states = replay(detector, times(8, shell('npm test')));

    expect(states).toEqual(['watching', 'watching', 'watching', 'hint', 'watching', 'watching', 'watching', 'end']);
    expect(detector.pending()).toBe('end');
  });

  it('reports the command, its error line and the count', () => {
    const detector = new LoopDetector(2);
    const [, hint] = times(2, shell('npm test')).map((event) => detector.note(event));
    const [, end] = times(2, shell('npm test')).map((event) => detector.note(event));

    expect(hint).toEqual({ state: 'hint', command: 'npm test', errorLine: 'Cannot find module x', count: 2 });
    expect(end).toMatchObject({ state: 'end', count: 4 });
  });

  it('does not count the same command with a different error', () => {
    const events = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => shell('npm test', `error ${n}`));

    expect(replay(new LoopDetector(4), events)).not.toContain('hint');
  });

  it('does not count the same command with a different exit code', () => {
    const events = [1, 2, 1, 2, 1, 2, 1, 2].map((code) => shell('npm test', 'same', code));

    expect(replay(new LoopDetector(4), events)).not.toContain('hint');
  });

  it('does not count a passing repeat, and a pass breaks the run', () => {
    expect(replay(new LoopDetector(4), times(8, passing))).not.toContain('hint');
    const broken = [...times(3, shell('npm test')), passing, ...times(3, shell('npm test'))];
    expect(replay(new LoopDetector(4), broken)).not.toContain('hint');
  });

  it('breaks the run on another command or another tool', () => {
    const other: ToolEvent = { tool: 'read', target: 'a.ts', status: 'ok', resultLine: '' };
    const events = [...times(3, shell('npm test')), other, ...times(3, shell('npm test'))];

    expect(replay(new LoopDetector(4), events)).not.toContain('hint');
  });

  it('reads whitespace and a trailing 2>&1 | tail -n as the same command', () => {
    const events = [
      shell('npm test'),
      shell('npm   test  2>&1 | tail -n 20'),
      shell('npm test 2>&1 | tail -5'),
      shell(' npm test '),
    ];

    expect(replay(new LoopDetector(4), events).at(-1)).toBe('hint');
    expect(normalizeCommand('npm  test 2>&1 | tail -n 20')).toBe('npm test');
  });

  it('ignores unfinished calls: they neither count nor break a run', () => {
    const background: ToolEvent = { tool: 'shell', target: 'sleep 100', status: 'unfinished', resultLine: '' };
    const events = [shell('npm test'), background, shell('npm test'), background, shell('npm test'), shell('npm test')];

    expect(replay(new LoopDetector(4), events).at(-1)).toBe('hint');
  });

  it('honors another LOOP_REPEAT', () => {
    expect(replay(new LoopDetector(2), times(2, shell('npm test')))).toEqual(['watching', 'hint']);
    expect(replay(new LoopDetector(6), times(5, shell('npm test')))).not.toContain('hint');
  });

  it('hands out a hint once and keeps an end pending', () => {
    const detector = new LoopDetector(1);
    detector.note(shell('npm test'));

    expect(detector.pending()).toBe('hint');
    expect(detector.resolveHint()).toBe(true);
    expect(detector.pending()).toBeNull();
    detector.note(shell('npm test'));
    expect(detector.resolveHint()).toBe(false);
    expect(detector.pending()).toBe('end');
  });
});
