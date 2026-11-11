import 'reflect-metadata';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { boot, save } from '../../testing/runs.spec-helpers';
import { FlowEntity } from '../entities';
import { RunRepository } from '../run.repository';
import { ChecksStep1795000000000, renamedPhases } from './1795000000000-checks-step';

const STORED = [
  '["requirements","brainstorm","implementation","code-review","ci"]',
  '["requirements","code-review"]',
  '["requirements","brainstorm"]',
  '["requirements","implementation"]',
  '["planning","implementation","checks","ci"]',
  '{',
];

async function withApp(test: (app: Awaited<ReturnType<typeof boot>>) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-checks-migration-'));
  const app = await boot(root);
  try {
    await mkdir(join(root, 'data'), { recursive: true });
    await test(app);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}

describe('ChecksStep migration', () => {
  it('turns stored requirements and brainstorm phases into planning and adds checks where implementation was', async () => {
    await withApp(async (app) => {
      const run = await save(app.get(RunRepository), 'proj-1', 'implement', 'waiting');
      const flows = app.get(DataSource).getRepository(FlowEntity);
      for (const phases of STORED) {
        await flows.save(
          flows.create({ runId: run.id, phases, fromStep: null, createdAt: '2026-01-01T00:00:00.000Z' }),
        );
      }
      const runner = app.get(DataSource).createQueryRunner();
      try {
        await new ChecksStep1795000000000().up(runner);
        await new ChecksStep1795000000000().up(runner);
      } finally {
        await runner.release();
      }
      expect((await flows.find({ order: { id: 'ASC' } })).map((row) => row.phases)).toEqual([
        '["planning","implementation","checks","code-review","ci"]',
        '["planning","code-review"]',
        '["planning"]',
        '["planning","implementation","checks"]',
        '["planning","implementation","checks","ci"]',
        '{',
      ]);
    });
  });

  it('keeps one planning and one checks however many old names a list has', () => {
    expect(renamedPhases(['requirements', 'brainstorm', 'planning', 'implementation', 'checks'])).toEqual([
      'planning',
      'implementation',
      'checks',
    ]);
  });
});
