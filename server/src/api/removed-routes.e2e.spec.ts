import { RunRepository } from '../history/run.repository';
import { createTestApp, type TestApp } from '../testing/test-app';
import { save } from '../testing/runs.spec-helpers';

describe('routes that no longer exist', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
    await save(app.app.get(RunRepository), 'proj-1', 'implement', 'waiting');
  });

  afterAll(async () => {
    await app.close();
  });

  const routes: [string, string][] = [
    ['POST', '/runs/proj-1/chat'],
    ['POST', '/runs/shell'],
    ['GET', '/runs/proj-1/shell'],
    ['POST', '/runs/proj-1/shell/lock'],
    ['POST', '/runs/proj-1/shell/unlock'],
    ['GET', '/runs/proj-1/snapshots'],
    ['POST', '/runs/proj-1/rewind'],
    ['GET', '/checkouts/origins'],
    ['POST', '/auth/cli/logins'],
    ['GET', '/auth/cli/logins/abc'],
    ['GET', '/tokens/cli/ABCD-1234'],
    ['POST', '/tokens/cli/ABCD-1234/approve'],
  ];

  it.each(routes)('answers 404 for %s %s', async (method, path) => {
    const response = await fetch(`${app.url}${path}`, {
      method,
      headers: { ...app.auth, 'content-type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined,
    });
    expect(response.status).toBe(404);
    // Nest's own answer for a path no route serves, not a handler's answer for a missing run or code.
    expect(((await response.json()) as { message: string }).message).toBe(`Cannot ${method} ${path}`);
  });
});
