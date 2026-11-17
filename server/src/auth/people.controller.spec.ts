import 'reflect-metadata';
import type { PeopleView } from '../contract/people';
import { createTestApp, type TestApp } from '../testing/test-app';

describe('the people routes', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await createTestApp();
  });

  afterEach(() => app.close());

  const send = (path: string, headers: object, method = 'GET', body?: object) =>
    fetch(`${app.url}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });

  it('lets a member neither list people nor change roles', async () => {
    const member = await app.personToken('ann');
    expect((await send('/people', member)).status).toBe(403);
    expect((await send('/people/ann/role', member, 'PUT', { role: 'admin' })).status).toBe(403);
  });

  it('lets an admin list people and change a role', async () => {
    await app.personToken('ann');
    const admin = await app.personToken('root', 'admin');
    const { people } = (await send('/people', admin).then((r) => r.json())) as PeopleView;
    expect(people.map((person) => person.login)).toEqual(expect.arrayContaining(['ann', 'root']));
    const changed = await send('/people/ann/role', admin, 'PUT', { role: 'admin' });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ login: 'ann', role: 'admin' });
  });

  it('answers 404 for an unknown login and 400 for an unknown role', async () => {
    const admin = await app.personToken('root', 'admin');
    expect((await send('/people/nobody/role', admin, 'PUT', { role: 'admin' })).status).toBe(404);
    expect((await send('/people/root/role', admin, 'PUT', { role: 'boss' })).status).toBe(400);
  });

  it('keeps the last admin', async () => {
    const response = await send('/people/test-admin/role', app.auth, 'PUT', { role: 'member' });
    expect(response.status).toBe(409);
  });
});
