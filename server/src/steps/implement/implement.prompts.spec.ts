import { withCommand } from '../../environment/check-failures';
import { markedTail } from '../../core/run-logs';
import { implementImproveFollowUp, OWN_CONFLICT_LEAD, ownConflictPrompt } from './implement.prompts';

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

describe('the prompt for the conflict of the parent’s own edits', () => {
  const prompt = ownConflictPrompt({
    repo: 'demo',
    files: ['src/shared.ts'],
    conflict: 'the worktree is at aaa111, origin/feature/x is at bbb222',
    requirements: 'Ship the field.',
    handoff: null,
  });

  it('names the files and both heads and asks to keep both sides', () => {
    expect(prompt.startsWith(`${OWN_CONFLICT_LEAD} demo`)).toBe(true);
    expect(prompt).toContain('- src/shared.ts');
    expect(prompt).toContain('aaa111');
    expect(prompt).toContain('bbb222');
    expect(prompt).toContain("keep both the parent's own edits and the merged tasks' changes");
    expect(prompt).not.toContain('The commit being replayed is');
  });
});
