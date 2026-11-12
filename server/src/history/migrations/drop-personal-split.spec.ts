import 'reflect-metadata';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { boot } from '../../testing/runs.spec-helpers';
import { UserSettingEntity } from '../connection-entities';
import { DropPersonalSplit1795600000000 } from './1795600000000-drop-personal-split';

describe('DropPersonalSplit migration', () => {
  it('deletes every stored split row and keeps the other settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-drop-split-'));
    const app = await boot(root);
    try {
      const dataSource = app.get(DataSource);
      const rows = dataSource.getRepository(UserSettingEntity);
      await rows.insert([
        { login: 'ada', key: 'split', value: 'true' },
        { login: 'ada', key: 'agents', value: '{}' },
        { login: 'grace', key: 'split', value: 'false' },
      ]);
      const runner = dataSource.createQueryRunner();
      try {
        await new DropPersonalSplit1795600000000().up(runner);
      } finally {
        await runner.release();
      }
      expect(await rows.find()).toEqual([{ login: 'ada', key: 'agents', value: '{}' }]);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
