import { HostUnavailable, RuntimeLimit } from '../../core/swarmloop-error';
import { tryNote } from './try-note';

describe('tryNote', () => {
  it('gives a host outage its own words', () => {
    const error = new HostUnavailable('GitLab', 'timeout', '2026-11-26T10:00:00.000Z');
    expect(tryNote(error)).toBe(error.message);
  });

  it('names the next tick for any other error', () => {
    expect(tryNote(new Error('boom'))).toBe('boom; next try on the next tick');
    expect(tryNote('plain text')).toBe('plain text; next try on the next tick');
  });

  it('names the next tick for a wait that is not a host outage', () => {
    expect(tryNote(new RuntimeLimit('limit reached', 'claude', '2026-11-26T10:00:00.000Z'))).toBe(
      'limit reached; next try on the next tick',
    );
  });
});
