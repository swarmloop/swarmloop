import { withCommand } from '../../environment/check-failures';
import { markedTail } from '../../core/run-logs';
import { implementImproveFollowUp } from './implement.prompts';

const notesOf = (tail: string) => `## checks\nrepo: required check failed (exit 1):\n${withCommand('npm test', tail)}`;

describe('the failed-check return prompt', () => {
  const lines = ['$ npm test', ...Array.from({ length: 498 }, (_, i) => `out ${i}`), 'exit 1'];
  const today = lines.slice(-80).join('\n').slice(-6000);
  const marked = markedTail(lines, 500, 80, 6000, '/srv/data/run-logs/r1/implement-a-command-0-log.txt');
  const mark = '… 420 earlier lines not shown; the whole output: /work/logs/implement-a-command-0-log.txt\n';

  it('equals today’s prompt plus the mark line after the command line', () => {
    const before = implementImproveFollowUp(notesOf(today), null);
    const after = implementImproveFollowUp(notesOf(marked), null);
    const at = before.indexOf('$ npm test\n') + '$ npm test\n'.length;
    expect(after).toBe(`${before.slice(0, at)}${mark}${before.slice(at)}`);
    expect(after.length).toBe(before.length + mark.length);
  });
});
