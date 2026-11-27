import type { CheckCommandView } from '../../contract/api';
import type { LoopEventEntity } from '../../history/entities';
import { returnWords } from './return-words';

const loop = (reason: string, detail: object | null = null): LoopEventEntity =>
  ({ reason, detail: detail ? JSON.stringify(detail) : null }) as LoopEventEntity;
const row = (command: string, name: string | null): CheckCommandView => ({ command, name }) as CheckCommandView;

describe('returnWords', () => {
  it('names the reviewers of a review return without their ids', () => {
    expect(returnWords('review', loop('review_requirements,review_quality,review_regressions'), [])).toBe(
      'Code review sent it back: requirements, quality, regressions',
    );
  });

  it('names a failed check by the short name of its row, and `checks` when the row has none', () => {
    const detail = { commands: ['npm test --prefix dashboard', 'knip --all', 'unknown cmd'] };
    const rows = [row('npm test --prefix dashboard', 'dashboard tests'), row('knip --all', null)];
    const words = returnWords('checks', loop('required checks failed', detail), rows);
    expect(words).toBe('Checks sent it back: dashboard tests, checks');
    expect(words).not.toContain('npm');
  });

  it('names the jobs of a CI return', () => {
    expect(returnWords('pipeline', loop('x', { jobs: ['test', 'lint'] }), [])).toBe('CI sent it back: test, lint');
  });

  it('says the first line of the reason when nothing names the cause', () => {
    expect(returnWords('pipeline', loop('merge conflict: automatic rebase\nmore'), [])).toBe(
      'CI sent it back: merge conflict: automatic rebase',
    );
  });

  it('says only who sent it back when nothing names the cause and the reason is empty', () => {
    expect(returnWords('pipeline', loop(''), [])).toBe('CI sent it back');
  });

  it('gives nothing for a counter that is no return', () => {
    expect(returnWords('stall', loop('x'), [])).toBeUndefined();
  });
});
