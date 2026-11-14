import { startCatalog } from '../../atlassian.spec-helpers';
import type { CatalogApp } from '../../atlassian.spec-helpers';
import { startFakeAtlassian } from '../../../testing/fake-atlassian';
import type { FakeAtlassian } from '../../../testing/fake-atlassian';
import { jiraConnection } from './jira-connection';

const TOKEN = 'atl-token-9876';

describe('the Jira connection', () => {
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

  it('is a form of site, email and token, with the token page of Atlassian', () => {
    const [flow] = jiraConnection.flows();
    expect(flow).toMatchObject({
      kind: 'form',
      helpUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    });
    expect(flow?.fields.map((field) => [field.name, field.secret])).toEqual([
      ['JIRA_BASE_URL', false],
      ['JIRA_EMAIL', false],
      ['JIRA_API_TOKEN', true],
    ]);
    expect(jiraConnection.secrets(form())).toEqual([TOKEN]);
  });

  it('reads the account and one project, and stores the form only on success', async () => {
    const card = await app.catalog.save('jira', 'ann', form());
    expect(card).toMatchObject({ id: 'jira', status: 'connected', account: 'Ann Lee', last4: '9876' });
    expect(atlassian.requests.map((request) => request.path)).toEqual([
      '/rest/api/3/myself',
      '/rest/api/3/project/search',
    ]);
    expect(await app.rows()).toHaveLength(1);
    expect(await app.personal.fields('jira', 'ann')).toEqual(form());
  });

  it('shows the message of Atlassian for a refused login and stores nothing', async () => {
    await expect(app.catalog.save('jira', 'ann', form('wrong'))).rejects.toThrow(
      'Client must be authenticated to access this resource.',
    );
    expect(await app.rows()).toEqual([]);
  });

  it('refuses an address that is not a web address before any request', async () => {
    await expect(app.catalog.save('jira', 'ann', { ...form(), JIRA_BASE_URL: 'ftp://example.com' })).rejects.toThrow(
      'The site URL must be a web address',
    );
    expect(atlassian.requests).toEqual([]);
  });

  it('lists the Jira and Confluence cards, Jira first', async () => {
    const ids = (await app.catalog.list('ann')).cards.map((card) => card.id);
    expect(ids.indexOf('jira')).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf('jira')).toBeLessThan(ids.indexOf('confluence'));
  });
});
