import 'reflect-metadata';
import { PersonalCredentials } from '../auth/personal-credentials.service';
import { HostAppsService } from '../auth/host-apps.service';
import { redact } from '../core/redact';
import { codeHostAdapters } from '../integrations/code-host/code-host-adapters';
import { runtimeConnections } from '../integrations/agent-runtime/agent-runtime.registry';
import { createTestApp, type TestApp } from './test-app';

const PERSON_KEY = 'person-key-0123456789';
const RUNTIME_KEY = 'runtime-key-0123456789';
const HOST_TOKEN = 'host-token-0123456789';
const JIRA_TOKEN = 'jira-token-0123456789';
const MACHINE_TOKEN = 'machine-token-0123456789';
const CLIENT_SECRET = 'client-secret-0123456789';
const PRIVATE_KEY = 'private-key-0123456789';

const line = (values: string[]) => values.map((value) => `value=${value}`).join(' ');
const masked = (values: string[]) => values.map(() => 'value=***').join(' ');

describe('redaction of what the owners hold', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await createTestApp({
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: RUNTIME_KEY,
        GITLAB_TOKEN: HOST_TOKEN,
        JIRA_API_TOKEN: JIRA_TOKEN,
        SWARMLOOP_TOKEN: MACHINE_TOKEN,
      },
    });
    const connection = runtimeConnections()[0];
    const fields = Object.fromEntries(
      connection.flows().flatMap((flow) => flow.fields.map((field) => [field.name, PERSON_KEY])),
    );
    await app.app.get(PersonalCredentials).store(connection, 'ada', fields, null);
    await app.app.get(HostAppsService).save({
      host: codeHostAdapters()[0].name,
      appId: '1',
      slug: 'swarmloop',
      clientId: 'client-id',
      clientSecret: CLIENT_SECRET,
      privateKey: PRIVATE_KEY,
      madeBy: null,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('masks every held secret in a log line while the app runs', () => {
    const values = [PERSON_KEY, RUNTIME_KEY, HOST_TOKEN, JIRA_TOKEN, MACHINE_TOKEN, CLIENT_SECRET, PRIVATE_KEY];

    expect(redact(line(values))).toBe(masked(values));
  });

  it('masks none of the registered secrets once the app is closed', async () => {
    const values = [RUNTIME_KEY, HOST_TOKEN, JIRA_TOKEN, MACHINE_TOKEN, CLIENT_SECRET, PRIVATE_KEY];
    await app.close();

    expect(redact(line(values))).toBe(line(values));
  });
});
