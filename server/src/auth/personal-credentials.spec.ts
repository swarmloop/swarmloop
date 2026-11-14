import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { AppConfig } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import { redact } from '../core/redact';
import { IntegrationSecretRepository } from '../history/integration-secret.repository';
import { repositoryDatabase } from '../history/repository.spec-helpers';
import { fakeConnection } from '../testing/fake-connection';
import { PersonalCredentials } from './personal-credentials.service';
import { SecretBox } from './secret-box';

const OWN_KEY = 'sk-ant-own-4d1e8f7a2b9c';
const ENV_KEY = 'sk-ant-env-91c0a5e3d7f2';
const claude = fakeConnection({ id: 'claude', fields: ['anthropicKey'], envName: 'ANTHROPIC_API_KEY' });

async function withCredentials(
  env: Partial<ReturnType<typeof testEnv>>,
  body: (credentials: PersonalCredentials, root: string) => Promise<void>,
): Promise<void> {
  const db = await repositoryDatabase();
  try {
    const config = new AppConfig(testEnv({ SWARMLOOP_ROOT: db.root, ...env }));
    const credentials = new PersonalCredentials(
      db.app.get(IntegrationSecretRepository),
      new SecretBox('k'),
      db.clock,
      config,
    );
    await body(credentials, db.root);
  } finally {
    await db.close();
  }
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}

describe('PersonalCredentials', () => {
  it('shows only the last four characters on the card and keeps the secret as ciphertext on disk', () =>
    withCredentials({}, async (credentials, root) => {
      await credentials.store(claude, 'ann', { anthropicKey: OWN_KEY }, 'ann@example.com');
      const card = await credentials.card(claude, 'ann', {});
      expect(card).toMatchObject({ status: 'connected', account: 'ann@example.com', last4: OWN_KEY.slice(-4) });
      expect(JSON.stringify(card)).not.toContain(OWN_KEY);
      const files = filesUnder(root).filter((file) => !file.endsWith(`${join('data', 'secret')}`));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        expect(readFileSync(file).includes(OWN_KEY)).toBe(false);
      }
      expect((await credentials.fields('claude', 'ann'))?.anthropicKey).toBe(OWN_KEY);
    }));

  it('masks a stored secret in a log line', () =>
    withCredentials({}, async (credentials) => {
      await credentials.store(claude, 'ann', { anthropicKey: OWN_KEY }, null);
      expect(redact(`launch failed with ${OWN_KEY}`)).toBe('launch failed with ***');
    }));

  it('gives the person their own credential first and the env as the fallback', () =>
    withCredentials({ ANTHROPIC_API_KEY: ENV_KEY }, async (credentials) => {
      await credentials.store(claude, 'ann', { anthropicKey: OWN_KEY }, null);
      expect(await credentials.runtimeCredential('claude', 'ann')).toEqual({
        name: 'ANTHROPIC_API_KEY',
        value: OWN_KEY,
        owner: 'ann',
      });
      expect(await credentials.runtimeCredential('claude', 'bob')).toEqual({
        name: 'ANTHROPIC_API_KEY',
        value: ENV_KEY,
        owner: null,
      });
      expect(await credentials.runtimeCredential('claude', null)).toMatchObject({ owner: null });
      expect(await credentials.credentialKey('claude', 'ann')).toBe('ann');
      expect(await credentials.credentialKey('claude', 'bob')).toBe('env');
      expect(await credentials.credentialKey('claude', null)).toBe('env');
    }));

  it('gives no credential when neither the person nor the env has one', () =>
    withCredentials({}, async (credentials) => {
      expect(await credentials.runtimeCredential('claude', 'ann')).toBeNull();
      expect(await credentials.card(claude, 'ann', {})).toMatchObject({
        status: 'not-connected',
        serverDefault: false,
      });
    }));

  it('shows the server default as connected without an account', () =>
    withCredentials({}, async (credentials) => {
      expect(await credentials.card(claude, 'ann', { ANTHROPIC_API_KEY: ENV_KEY })).toMatchObject({
        status: 'connected',
        account: null,
        last4: null,
        serverDefault: true,
      });
    }));

  it('shows a broken connection as needing attention, and a disconnected one as gone', () =>
    withCredentials({}, async (credentials) => {
      await credentials.store(claude, 'ann', { anthropicKey: OWN_KEY }, null);
      await credentials.markBroken('claude', 'ann', 'the key was revoked');
      expect(await credentials.card(claude, 'ann', {})).toMatchObject({
        status: 'attention',
        reason: 'the key was revoked',
      });
      await credentials.disconnect('claude', 'ann');
      expect(await credentials.fields('claude', 'ann')).toBeNull();
      expect(await credentials.card(claude, 'ann', {})).toMatchObject({ status: 'not-connected' });
    }));

  it('falls back to the env when the stored secret cannot be opened', async () => {
    const db = await repositoryDatabase();
    try {
      const rows = db.app.get(IntegrationSecretRepository);
      const config = new AppConfig(testEnv({ SWARMLOOP_ROOT: db.root, ANTHROPIC_API_KEY: ENV_KEY }));
      await new PersonalCredentials(rows, new SecretBox('k'), db.clock, config).store(
        claude,
        'ann',
        { anthropicKey: OWN_KEY },
        null,
      );
      const otherKey = new PersonalCredentials(rows, new SecretBox('another key'), db.clock, config);
      expect(await otherKey.runtimeCredential('claude', 'ann')).toMatchObject({ value: ENV_KEY, owner: null });
      expect(await otherKey.credentialKey('claude', 'ann')).toBe('env');
    } finally {
      await db.close();
    }
  });

  it('lists the cards of several connections for a person', () =>
    withCredentials({}, async (credentials) => {
      const codex = fakeConnection({ id: 'codex', fields: ['codexApiKey'] });
      await credentials.store(claude, 'ann', { anthropicKey: OWN_KEY }, null);
      const { cards } = await credentials.cards([claude, codex], 'ann', {});
      expect(cards.map((card) => [card.id, card.status])).toEqual([
        ['claude', 'connected'],
        ['codex', 'not-connected'],
      ]);
    }));
});
