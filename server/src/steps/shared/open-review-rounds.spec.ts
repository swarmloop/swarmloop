import { LiveHub } from '../../live/live.hub';
import { OpenReviewRounds } from './open-review-rounds';

describe('open review rounds', () => {
  it('notifies the live view when the open round is set, refined and cleared', () => {
    const live = new LiveHub();
    const changed: string[] = [];
    live.onChanged((key) => changed.push(key));
    const rounds = new OpenReviewRounds(live);

    rounds.open('PROJ-1', { reviewers: ['quality'], reportDue: false, reportStarted: false });
    expect(changed).toEqual(['PROJ-1']);
    expect(rounds.of('PROJ-1')?.reviewers).toEqual(['quality']);

    rounds.open('PROJ-1', { reviewers: ['quality', 'security'], reportDue: true, reportStarted: false });
    expect(changed).toEqual(['PROJ-1', 'PROJ-1']);
    expect(rounds.of('PROJ-1')?.reviewers).toEqual(['quality', 'security']);

    rounds.reportStarted('PROJ-1');
    expect(changed).toHaveLength(3);
    expect(rounds.of('PROJ-1')?.reportStarted).toBe(true);

    rounds.close('PROJ-1');
    expect(changed).toHaveLength(4);
    expect(rounds.of('PROJ-1')).toBeUndefined();

    rounds.close('PROJ-1');
    rounds.reportStarted('PROJ-1');
    expect(changed).toHaveLength(4);
  });
});
