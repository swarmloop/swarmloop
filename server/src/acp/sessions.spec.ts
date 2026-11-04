import { SessionStore } from './sessions';

describe('ACP sessions', () => {
  it('creates sessions and restores stored runs by their session id', () => {
    const sessions = new SessionStore({ cwd: '/work/app', now: () => 1 });
    expect(sessions.open({ cwd: 'checkout', roots: ['/work/extra'], mcpServers: [] })).toMatchObject({
      id: 'sloop-1-0',
      cwd: '/work/app/checkout',
      folders: ['/work/app/checkout', '/work/extra'],
      runKey: null,
    });
    expect(sessions.restore({ sessionId: 'PROJ-1', cwd: '/work/app' })).toMatchObject({
      id: 'PROJ-1',
      runKey: 'PROJ-1',
    });
  });

  it('does not restore an unknown transient session', () => {
    const sessions = new SessionStore({ cwd: '/work/app', now: () => 1 });
    expect(() => sessions.get('sloop-1-0')).toThrow('session is missing');
  });
});
