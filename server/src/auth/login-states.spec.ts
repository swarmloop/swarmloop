import { FakeClock } from '../core/fake-clock.spec-helpers';
import { LoginStates, MAX_PENDING } from './login-states';

describe('LoginStates', () => {
  it('answers a login once, and not after ten minutes', () => {
    const clock = new FakeClock();
    const states = new LoginStates(clock);
    const first = states.start('github');
    expect(states.take(first.state)).toMatchObject({ provider: 'github', verifier: first.verifier });
    expect(states.take(first.state)).toBeNull();
    const late = states.start('gitlab');
    clock.advance(10 * 60 * 1000);
    expect(states.take(late.state)).toBeNull();
  });

  it('returns the stored next path with the login', () => {
    const states = new LoginStates(new FakeClock());
    const started = states.start('github', true, undefined, '/runs/x');
    expect(states.take(started.state)).toMatchObject({ next: '/runs/x' });
  });

  it('holds at most MAX_PENDING logins and drops the oldest first', () => {
    const states = new LoginStates(new FakeClock());
    const oldest = states.start('github');
    for (let count = 1; count <= MAX_PENDING; count += 1) {
      states.start('github');
    }
    expect(states.take(oldest.state)).toBeNull();
    const newest = states.start('github');
    expect(states.take(newest.state)).not.toBeNull();
  });

  it('sweeps expired logins and keeps the live ones', () => {
    const clock = new FakeClock();
    const states = new LoginStates(clock);
    const old = states.start('github');
    clock.advance(6 * 60 * 1000);
    const recent = states.start('github');
    clock.advance(5 * 60 * 1000);
    states.start('github');
    expect(states.take(old.state)).toBeNull();
    expect(states.take(recent.state)).not.toBeNull();
  });
});
