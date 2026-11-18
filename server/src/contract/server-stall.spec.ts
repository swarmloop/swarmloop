import { STALL_KIND_WORDS } from './server-stall';

describe('STALL_KIND_WORDS', () => {
  it('names each kind of stall in plain words', () => {
    expect(STALL_KIND_WORDS).toEqual({ 'server-blocked': 'server blocked', 'host-paused': 'machine paused' });
  });
});
