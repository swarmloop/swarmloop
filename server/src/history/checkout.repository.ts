import { Injectable, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { LiveHub } from '../live/live.hub';
import { CheckoutEntity, PasteEntity } from './entities';
import { RunOpenItems } from './run-open-items';
import { transaction } from './transaction';

@Injectable()
export class CheckoutRepository {
  constructor(
    @InjectRepository(CheckoutEntity) private readonly checkouts: Repository<CheckoutEntity>,
    @InjectRepository(PasteEntity) private readonly pastes: Repository<PasteEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly openItems: RunOpenItems,
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

  async listPastes(runKey: string): Promise<PasteEntity[]> {
    return this.pastes.find({ where: { runKey }, order: { id: 'ASC' } });
  }

  async savePaste(runKey: string, url: string, body: string): Promise<void> {
    await transaction(this.dataSource, async (manager) => {
      const pastes = manager.getRepository(PasteEntity);
      const existing = await pastes.findOne({ where: { runKey, url } });
      if (existing) {
        existing.body = body;
        await pastes.save(existing);
      } else {
        await pastes.save(pastes.create({ runKey, url, body }));
      }
      await this.openItems.hold(manager, { key: runKey });
    });
    this.live?.changed(runKey);
  }
}
