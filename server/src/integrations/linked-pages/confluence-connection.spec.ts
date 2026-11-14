import { startCatalog } from '../atlassian.spec-helpers';
import type { CatalogApp } from '../atlassian.spec-helpers';
import { startFakeAtlassian } from '../../testing/fake-atlassian';
import type { FakeAtlassian } from '../../testing/fake-atlassian';
import { confluenceConnection } from './confluence-connection';

const TOKEN = 'atl-token-4321';

describe('the Confluence connection', () => {
  let atlassian: FakeAtlassian;
  let app: CatalogApp;
  const form = (token = TOKEN) => ({
    JIRA_BASE_URL: atlassian.base,
    JIRA_EMAIL: 'ann@example.com',
    JIRA_API_TOKEN: token,
  });

  beforeEach(async () => {
    atlassian = await startFakeAtlassian([{ email: 'ann@example.com', token: TOKEN, name: 'Ann Lee' }]);
    app = await startCatalog();
  });
  afterEach(async () => {
    await app.close();
    await atlassian.close();
  });

  it('is the same form as Jira, with only the token secret', () => {
    const [flow] = confluenceConnection.flows();
    expect(flow?.kind).toBe('form');
    expect(confluenceConnection.secrets(form())).toEqual([TOKEN]);
  });

  it('reads the account and one space, and stores the form only on success', async () => {
    const card = await app.catalog.save('confluence', 'ann', form());
    expect(card).toMatchObject({ id: 'confluence', status: 'connected', account: 'Ann Lee', last4: '4321' });
    expect(atlassian.requests.map((request) => request.path)).toEqual([
      '/wiki/rest/api/user/current',
      '/wiki/rest/api/space',
    ]);
    expect(await app.rows()).toHaveLength(1);
  });

  it('shows the message of Atlassian for a refused login and stores nothing', async () => {
    await expect(app.catalog.save('confluence', 'ann', form('wrong'))).rejects.toThrow(
      'Client must be authenticated to access this resource.',
    );
    expect(await app.rows()).toEqual([]);
  });
});
