import { Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LiveHub } from '../live/live.hub';
import { CheckoutEntity, DenyPathEntity, PasteEntity } from './entities';

@Injectable()
export class CheckoutRepository {
  constructor(
    @InjectRepository(CheckoutEntity) private readonly checkouts: Repository<CheckoutEntity>,
    @InjectRepository(DenyPathEntity) private readonly denyPaths: Repository<DenyPathEntity>,
    @InjectRepository(PasteEntity) private readonly pastes: Repository<PasteEntity>,
    @Optional() private readonly live?: LiveHub,
  ) {}

  async listCheckouts(): Promise<CheckoutEntity[]> {
    return this.checkouts.find({ order: { name: 'ASC' } });
  }

  async saveCheckout(name: string, path: string): Promise<void> {
    const existing = await this.checkouts.findOne({ where: { name } });
    if (existing) {
      existing.path = path;
      await this.checkouts.save(existing);
      return;
    }
    await this.checkouts.save(this.checkouts.create({ name, path }));
  }

  async listDenyPaths(): Promise<string[]> {
    const rows = await this.denyPaths.find({ order: { pattern: 'ASC' } });
    return rows.map((row) => row.pattern);
  }

  async listPastes(runKey: string): Promise<PasteEntity[]> {
    return this.pastes.find({ where: { runKey }, order: { id: 'ASC' } });
  }

  async savePaste(runKey: string, url: string, body: string): Promise<void> {
    const existing = await this.pastes.findOne({ where: { runKey, url } });
    if (existing) {
      existing.body = body;
      await this.pastes.save(existing);
    } else {
      await this.pastes.save(this.pastes.create({ runKey, url, body }));
    }
    this.live?.changed(runKey);
  }
}
