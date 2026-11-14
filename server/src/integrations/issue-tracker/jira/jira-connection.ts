import type { Connection } from '../../connection';
import { atlassianFlow, testAtlassianSite } from '../../atlassian-site';
import { jiraConfigured } from './jira-ticket-keys';
import type { SwarmloopEnv } from '../../../config/env';

/** Jira on the Connections page: the site, the email and an API token. */
export const jiraConnection: Connection = {
  id: 'jira',
  logo: 'jira',
  label: 'Jira',
  purpose: 'Reads your tickets, comments and linked pages for the requirements',
  flows: () => [atlassianFlow('Connect Jira')],
  envDefault: (env) => jiraConfigured(env as SwarmloopEnv),
  secrets: (fields) => [fields.JIRA_API_TOKEN ?? ''].filter(Boolean),
  test: (fields, probe) =>
    testAtlassianSite(fields, probe, {
      account: '/rest/api/3/myself',
      sample: '/rest/api/3/project/search?maxResults=1',
    }),
};
