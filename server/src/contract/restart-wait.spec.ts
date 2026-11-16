import { NO_SAMPLES_AFTER_RESTART, restartWaitSentence } from './restart-wait';

describe('restartWaitSentence', () => {
  it('says when the server restarted and that the step goes on by itself', () => {
    expect(restartWaitSentence('2026-11-14T22:46:00.000Z', () => '23:46')).toBe(
      'The server restarted at 23:46. Waiting for the agent it had started to finish; then this step goes on by itself.',
    );
  });
});

describe('NO_SAMPLES_AFTER_RESTART', () => {
  it('reads as one plain line', () => {
    expect(NO_SAMPLES_AFTER_RESTART).toBe('No samples: the server that measured these containers restarted.');
  });
});
