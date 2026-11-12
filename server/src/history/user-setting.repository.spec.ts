import { repositoryDatabase } from './repository.spec-helpers';
import { UserSettingRepository } from './user-setting.repository';

const plan = { main: { plan: [{ runtime: 'claude', model: 'opus' }] } };

describe('UserSettingRepository', () => {
  it('reads back what was saved', async () => {
    const db = await repositoryDatabase();
    try {
      const settings = db.app.get(UserSettingRepository);
      await settings.save('ada', { agents: plan, split: true });
      expect(await settings.read('ada')).toEqual({ agents: plan, split: true });
    } finally {
      await db.close();
    }
  });

  it('replaces the earlier save and drops a key left out', async () => {
    const db = await repositoryDatabase();
    try {
      const settings = db.app.get(UserSettingRepository);
      await settings.save('ada', { agents: plan, split: true });
      await settings.save('ada', { split: false });
      expect(await settings.read('ada')).toEqual({ split: false });
    } finally {
      await db.close();
    }
  });

  it('keeps each person apart and reads null for a person with no rows', async () => {
    const db = await repositoryDatabase();
    try {
      const settings = db.app.get(UserSettingRepository);
      await settings.save('ada', { split: true });
      await settings.save('grace', { split: false });
      expect(await settings.read('ada')).toEqual({ split: true });
      expect(await settings.read('grace')).toEqual({ split: false });
      expect(await settings.read('alan')).toBeNull();
    } finally {
      await db.close();
    }
  });
});
