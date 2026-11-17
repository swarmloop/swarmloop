import { getRepositoryToken } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import type { Repository } from 'typeorm';
import { AppConfig } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import { PersonalTokenEntity } from '../history/people-entities';
import { repositoryDatabase } from '../history/repository.spec-helpers';
import { PersonalTokens } from './personal-tokens.service';

const DAY = 24 * 3600 * 1000;

async function withTokens(
  env: Partial<ReturnType<typeof testEnv>>,
  body: (
    tokens: PersonalTokens,
    db: Awaited<ReturnType<typeof repositoryDatabase>>,
    rows: Repository<PersonalTokenEntity>,
  ) => Promise<void>,
): Promise<void> {
  const db = await repositoryDatabase();
  try {
    const rows = db.app.get<Repository<PersonalTokenEntity>>(getRepositoryToken(PersonalTokenEntity));
    await body(
      new PersonalTokens(db.clock, new AppConfig(testEnv({ SWARMLOOP_ROOT: db.root, ...env })), rows),
      db,
      rows,
    );
  } finally {
    await db.close();
  }
}

describe('PersonalTokens', () => {
  it('returns the value once on create and stores only its sha256', () =>
    withTokens({}, async (tokens, _db, rows) => {
      const created = await tokens.create('ann', 'laptop', 30);
      const stored = await rows.find();
      expect(stored).toHaveLength(1);
      expect(stored[0].tokenHash).toBe(createHash('sha256').update(created.value).digest('hex'));
      expect(JSON.stringify(stored)).not.toContain(created.value);
      expect(JSON.stringify(await tokens.list('ann'))).not.toContain(created.value);
      expect(await tokens.personOf(created.value)).toBe('ann');
    }));

  it('refuses unknown, expired and revoked tokens', () =>
    withTokens({}, async (tokens, db) => {
      expect(await tokens.personOf('sl_unknown')).toBeNull();
      const expiring = await tokens.create('ann', 'short', 30);
      const revoked = await tokens.create('ann', 'gone', null);
      await tokens.revoke('bob', revoked.id);
      expect(await tokens.personOf(revoked.value)).toBe('ann');
      await tokens.revoke('ann', revoked.id);
      expect(await tokens.personOf(revoked.value)).toBeNull();
      expect(await tokens.personOf(expiring.value)).toBe('ann');
      db.clock.advance(30 * DAY);
      expect(await tokens.personOf(expiring.value)).toBeNull();
    }));

  it('updates last used at most once a minute', () =>
    withTokens({}, async (tokens, db) => {
      const { value } = await tokens.create('ann', 'laptop', null);
      await tokens.personOf(value);
      const first = (await tokens.list('ann'))[0].lastUsedAt;
      expect(first).toBe(db.clock.iso());
      db.clock.advance(30_000);
      await tokens.personOf(value);
      expect((await tokens.list('ann'))[0].lastUsedAt).toBe(first);
      db.clock.advance(30_000);
      await tokens.personOf(value);
      expect((await tokens.list('ann'))[0].lastUsedAt).toBe(db.clock.iso());
    }));

  it('adopts a pasted value of 32 characters or more, and refuses a shorter one or another person’s', () =>
    withTokens({}, async (tokens, _db, rows) => {
      const value = 'x'.repeat(32);
      await expect(tokens.adopt('ann', 'short', 'x'.repeat(31), null)).rejects.toThrow('at least 32');
      await tokens.adopt('ann', 'pasted', `  ${value}\n`, null);
      await expect(tokens.adopt('bob', 'pasted', value, null)).rejects.toThrow('another person');
      await tokens.adopt('ann', 'again', value, null);
      expect(await rows.count()).toBe(1);
      expect(await tokens.personOf(value)).toBe('ann');
    }));

  it('imports SWARMLOOP_TOKEN for the admin with no expiry, and skips one a person already owns', async () => {
    const value = 'short';
    await withTokens({ SWARMLOOP_TOKEN: value }, async (tokens) => {
      await tokens.adoptEnvToken('ann');
      await tokens.adoptEnvToken('bob');
      expect(await tokens.personOf(value)).toBe('ann');
      expect(await tokens.list('bob')).toEqual([]);
      expect(await tokens.list('ann')).toMatchObject([{ name: 'from SWARMLOOP_TOKEN', expiresAt: null }]);
    });
    await withTokens({ SWARMLOOP_TOKEN: 'z'.repeat(40) }, async (tokens) => {
      await tokens.adopt('bob', 'own', 'z'.repeat(40), null);
      await tokens.adoptEnvToken('ann');
      expect(await tokens.list('ann')).toEqual([]);
    });
  });
});
