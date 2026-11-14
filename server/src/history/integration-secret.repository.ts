import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IntegrationSecretEntity } from './connection-entities';

/** The stored secrets of the Connections page. It holds ciphertext and metadata; sealing and opening are not its job. */
@Injectable()
export class IntegrationSecretRepository {
  constructor(@InjectRepository(IntegrationSecretEntity) private readonly rows: Repository<IntegrationSecretEntity>) {}

  find(id: string): Promise<IntegrationSecretEntity | null> {
    return this.rows.findOneBy({ id });
  }

  /** Inserts the row, or replaces the earlier row of the same id. */
  async save(row: IntegrationSecretEntity): Promise<void> {
    await this.rows.save(row);
  }

  async delete(id: string): Promise<void> {
    await this.rows.delete({ id });
  }

  async update(id: string, patch: Partial<Omit<IntegrationSecretEntity, 'id'>>): Promise<void> {
    await this.rows.update({ id }, patch);
  }
}
