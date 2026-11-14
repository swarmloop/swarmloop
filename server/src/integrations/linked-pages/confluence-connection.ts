import type { SwarmloopEnv } from '../../config/env';
import { atlassianFlow, testAtlassianSite } from '../atlassian-site';
import type { Connection } from '../connection';
import { jiraEnvFields } from '../issue-tracker/jira/jira-ticket-keys';

/** Confluence on the Connections page. The server's Jira values read its pages today, so they are its default. */
export const confluenceConnection: Connection = {
  id: 'confluence',
  logo: 'confluence',
  label: 'Confluence',
  purpose: 'Reads the Confluence pages that your tickets link to',
  flows: () => [atlassianFlow('Connect Confluence')],
  envDefault: (env) => jiraEnvFields(env as SwarmloopEnv),
  secrets: (fields) => [fields.JIRA_API_TOKEN ?? ''].filter(Boolean),
  test: (fields, probe) =>
    testAtlassianSite(fields, probe, {
      account: '/wiki/rest/api/user/current',
      sample: '/wiki/rest/api/space?limit=1',
    }),
};
