import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, type Repository } from 'typeorm';
import { AppConfig } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import { PersonalTokenEntity, PersonEntity } from '../history/people-entities';
import { PeopleAndTokens1796300000000 } from '../history/migrations/1796300000000-people-and-tokens';
import { PersonAvatar1797500000000 } from '../history/migrations/1797500000000-person-avatar';
import { repositoryDatabase } from '../history/repository.spec-helpers';
import { PeopleService } from './people.service';
import { PersonalTokens } from './personal-tokens.service';

async function withPeople(
  env: Partial<ReturnType<typeof testEnv>>,
  body: (
    people: PeopleService,
    tokens: PersonalTokens,
    db: Awaited<ReturnType<typeof repositoryDatabase>>,
  ) => Promise<void>,
): Promise<void> {
  const db = await repositoryDatabase();
  try {
    const tokens = new PersonalTokens(
      db.clock,
      new AppConfig(testEnv({ SWARMLOOP_ROOT: db.root, ...env })),
      db.app.get<Repository<PersonalTokenEntity>>(getRepositoryToken(PersonalTokenEntity)),
    );
    const people = new PeopleService(
      db.clock,
      tokens,
      db.app.get<Repository<PersonEntity>>(getRepositoryToken(PersonEntity)),
    );
    await body(people, tokens, db);
  } finally {
    await db.close();
  }
}

describe('PeopleService', () => {
  it('makes the first person seen an admin and later ones members', () =>
    withPeople({}, async (people) => {
      await people.seen('ann');
      await people.seen('bob');
      await people.seen('bob');
      expect(await people.list()).toMatchObject([
        { login: 'ann', role: 'admin' },
        { login: 'bob', role: 'member' },
      ]);
      expect(await people.roleOf('nobody')).toBe('member');
      expect(await people.isAdmin('ann')).toBe(true);
    }));

  it('stores the photo of a new and an existing person, and a sign-in without one keeps it', () =>
    withPeople({}, async (people) => {
      await people.seen('ann', 'https://avatars.test/ann.png');
      expect(await people.avatarOf('ann')).toBe('https://avatars.test/ann.png');
      await people.seen('ann');
      expect(await people.avatarOf('ann')).toBe('https://avatars.test/ann.png');
      await people.seen('ann', 'https://avatars.test/ann-2.png');
      expect(await people.avatarOf('ann')).toBe('https://avatars.test/ann-2.png');
      await people.seen('bob');
      expect(await people.avatarOf('bob')).toBeNull();
      expect(await people.avatarOf('nobody')).toBeNull();
    }));

  it('lets an admin change roles and refuses a member, an unknown login and the last admin', () =>
    withPeople({}, async (people) => {
      await people.seen('ann');
      await people.seen('bob');
      await expect(people.setRole('bob', 'ann', 'member')).rejects.toThrow('only an admin can change roles');
      await expect(people.setRole('ann', 'zed', 'admin')).rejects.toThrow('no such person');
      await expect(people.setRole('ann', 'ann', 'member')).rejects.toThrow('one admin must stay');
      await people.setRole('ann', 'bob', 'admin');
      await people.setRole('bob', 'ann', 'member');
      expect(await people.list()).toMatchObject([
        { login: 'ann', role: 'member' },
        { login: 'bob', role: 'admin' },
      ]);
    }));

  it('imports SWARMLOOP_TOKEN, even a short one, when it makes the first admin', () =>
    withPeople({ SWARMLOOP_TOKEN: 'short' }, async (people, tokens) => {
      await people.seen('ann');
      await people.seen('bob');
      expect(await tokens.personOf('short')).toBe('ann');
      expect(await tokens.list('ann')).toMatchObject([{ name: 'from SWARMLOOP_TOKEN', expiresAt: null }]);
      expect(await tokens.list('bob')).toEqual([]);
    }));

  it('does not import a revoked SWARMLOOP_TOKEN again at the next start', () =>
    withPeople({ SWARMLOOP_TOKEN: 'short' }, async (people, tokens) => {
      await people.seen('ann');
      const [imported] = await tokens.list('ann');
      await tokens.revoke('ann', imported.id);
      await people.onModuleInit();
      expect(await tokens.personOf('short')).toBeNull();
    }));

  it('imports SWARMLOOP_TOKEN on start when an admin exists and does nothing when none does', () =>
    withPeople({ SWARMLOOP_TOKEN: 'short' }, async (people, tokens, db) => {
      await people.onModuleInit();
      expect(await tokens.personOf('short')).toBeNull();
      await db.app.get<Repository<PersonEntity>>(getRepositoryToken(PersonEntity)).save({
        login: 'ann',
        role: 'admin',
        createdAt: db.clock.iso(),
        envTokenImportedAt: null,
      });
      await people.onModuleInit();
      expect(await tokens.personOf('short')).toBe('ann');
    }));

  it('migrates each person app maker to an admin and skips machine', () =>
    withPeople({}, async (people, _tokens, db) => {
      const source = db.app.get(DataSource);
      const runner = source.createQueryRunner();
      try {
        const migration = new PeopleAndTokens1796300000000();
        await migration.down(runner);
        const insert = `INSERT INTO host_apps (id, app_id, slug, client_id, client_secret, private_key, made_by) VALUES (?, '1', 's', 'c', 'x', 'k', ?)`;
        await runner.query(insert, ['github', 'ann']);
        await runner.query(insert, ['gitlab', 'machine']);
        await runner.query(insert, ['gitea', null]);
        await migration.up(runner);
        await new PersonAvatar1797500000000().up(runner);
      } finally {
        await runner.release();
      }
      expect(await people.list()).toMatchObject([{ login: 'ann', role: 'admin' }]);
    }));
});
