import { DataSource } from 'typeorm';
import { UserSettingEntity } from './connection-entities';
import { repositoryDatabase } from './repository.spec-helpers';
import { UserSettingRepository } from './user-setting.repository';

const plan = { main: { plan: [{ runtime: 'claude', model: 'opus' }] } };
const review = { subtask: { review: [{ runtime: 'claude', model: 'sonnet' }] } };

describe('UserSettingRepository', () => {
  it('reads back what was saved', async () => {
    const db = await repositoryDatabase();
    try {
      const settings = db.app.get(UserSettingRepository);
      await settings.save('ada', { agents: plan });
      expect(await settings.read('ada')).toEqual({ agents: plan });
    } finally {
      await db.close();
    }
  });

  it('replaces the earlier save and drops a key left out', async () => {
    const db = await repositoryDatabase();
    try {
      const settings = db.app.get(UserSettingRepository);
      await settings.save('ada', { agents: plan });
      await settings.save('ada', {});
      expect(await settings.read('ada')).toBeNull();
      await settings.save('ada', { agents: review });
      expect(await settings.read('ada')).toEqual({ agents: review });
    } finally {
      await db.close();
    }
  });

  it('keeps each person apart and reads null for a person with no rows', async () => {
    const db = await repositoryDatabase();
    try {
      const settings = db.app.get(UserSettingRepository);
      await settings.save('ada', { agents: plan });
      await settings.save('grace', { agents: review });
      expect(await settings.read('ada')).toEqual({ agents: plan });
      expect(await settings.read('grace')).toEqual({ agents: review });
      expect(await settings.read('alan')).toBeNull();
    } finally {
      await db.close();
    }
  });

  it('ignores a stored key that is not a setting any more, such as a personal split', async () => {
    const db = await repositoryDatabase();
    try {
      const settings = db.app.get(UserSettingRepository);
      const rows = db.app.get(DataSource).getRepository(UserSettingEntity);
      await rows.insert({ login: 'ada', key: 'agents', value: JSON.stringify(plan) });
      await rows.insert({ login: 'ada', key: 'split', value: 'true' });
      await rows.insert({ login: 'grace', key: 'split', value: 'true' });
      expect(await settings.read('ada')).toEqual({ agents: plan });
      expect(await settings.read('grace')).toBeNull();
    } finally {
      await db.close();
    }
  });
});
