import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { SettingsBody } from '../contract/api';
import { UserSettingEntity } from './connection-entities';
import { transaction } from './transaction';

/** The keys of `SettingsBody`; a stored row with another key (an old personal `split`) is ignored. */
const KNOWN_KEYS = ['agents'];

/** The settings a person chose for their own runs. One row per setting key; a key without a row is the server default. */
@Injectable()
export class UserSettingRepository {
  constructor(@InjectRepository(UserSettingEntity) private readonly rows: Repository<UserSettingEntity>) {}

  /** The person's stored settings, or null when they have none. */
  async read(login: string): Promise<SettingsBody | null> {
    const stored = (await this.rows.findBy({ login })).filter((row) => KNOWN_KEYS.includes(row.key));
    if (stored.length === 0) {
      return null;
    }
    return Object.fromEntries(stored.map((row) => [row.key, JSON.parse(row.value)]));
  }

  /** Replaces the person's settings: a key left out of `body` is no longer stored. */
  async save(login: string, body: SettingsBody): Promise<void> {
    await transaction(this.rows.manager.connection, async (manager) => {
      await manager.delete(UserSettingEntity, { login });
      const inserts = Object.entries(body)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => ({ login, key, value: JSON.stringify(value) }));
      if (inserts.length > 0) {
        await manager.insert(UserSettingEntity, inserts);
      }
    });
  }
}
