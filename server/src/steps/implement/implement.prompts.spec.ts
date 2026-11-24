import { withCommand } from '../../environment/check-failures';
import { markedTail } from '../../core/run-logs';
import {
  implementImproveFollowUp,
  OWN_CONFLICT_LEAD,
  ownConflictPrompt,
  rebaseConflictPrompt,
} from './implement.prompts';

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

describe('the prompt for a rebase conflict', () => {
  it('tells the agent to take the base version of a lockfile and run the package manager again', () => {
    const prompt = rebaseConflictPrompt({
      repo: 'demo',
      files: ['package-lock.json'],
      requirements: 'r',
      base: 'abc',
      commit: 'def',
    });
    expect(prompt).toContain(
      "A conflict in a lockfile or another file the package manager writes is not merged by hand: keep the new base's version of it, then run the package manager again for this branch's changes to its manifest.",
    );
    expect(prompt).toContain('Do not run git.');
  });
});

describe('the planner’s answer in a conflict prompt', () => {
  const answer = {
    key: 'answer-1',
    role: 'planner',
    kind: 'answer',
    from: 'implement',
    text: 'Keep the base version of src/shared.ts.',
    at: '2026-01-01T00:00:00.000Z',
    state: 'pending',
  } as const;
  const rebase = { repo: 'demo', files: ['src/shared.ts'], requirements: 'r', base: 'abc', commit: 'def' };
  const own = { repo: 'demo', files: ['src/shared.ts'], conflict: 'c', requirements: 'r', handoff: null };

  it('is carried as the answer section by the rebase prompt and by the own-edits prompt', () => {
    for (const prompt of [rebaseConflictPrompt({ ...rebase, answer }), ownConflictPrompt({ ...own, answer })]) {
      expect(prompt).toContain('Answer from the planner:');
      expect(prompt).toContain(answer.text);
    }
  });

  it('leaves both prompts as they were without an answer', () => {
    for (const prompt of [rebaseConflictPrompt(rebase), ownConflictPrompt(own)]) {
      expect(prompt).not.toContain('Answer from the planner');
    }
  });
});
