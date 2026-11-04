import type { ServerApi } from './server-api';
import { Sessions } from './sessions';

describe('ACP sessions', () => {
  it('binds loaded run keys and keeps updated session folders', () => {
    const sessions = new Sessions({
      api: { stop: async () => ({ key: 'PROJ-1', status: 'done' }) } as unknown as ServerApi,
      cwd: '/work/app',
      clock: { now: () => 1, iso: () => '2026-01-01T00:00:00.000Z' },
    });

    const session = sessions.resume({ sessionId: 'PROJ-1', cwd: 'checkout', roots: ['other'] });

    expect(session).toMatchObject({
      id: 'PROJ-1',
      cwd: '/work/app/checkout',
      folders: ['/work/app/checkout', '/work/app/other'],
      runKey: 'PROJ-1',
    });
  });
});
