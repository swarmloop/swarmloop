import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AgentCallQueries } from '../history/agent-call-queries';
import { at, seedCall, seedPing } from '../history/agent-call-queries.spec-helpers';
import { AgentCallRepository } from '../history/agent-call.repository';
import { repositoryDatabase } from '../history/repository.spec-helpers';
import { AgentCallsController } from './agent-calls.controller';

async function withController(test: (controller: AgentCallsController, log: AgentCallRepository) => Promise<void>) {
  const db = await repositoryDatabase();
  try {
    const controller = new AgentCallsController(new AgentCallQueries(db.app.get(DataSource)));
    await test(controller, db.app.get(AgentCallRepository));
  } finally {
    await db.close();
  }
}

describe('AgentCallsController', () => {
  it('answers the totals, the timeline and the keep-warm figures of the log', async () => {
    await withController(async (controller, log) => {
      const first = await seedCall(log, {
        usd: 2,
        start: { taskSlug: 'a', step: 'implement', chatId: 'c1', startedAt: at(10) },
        end: { finishedAt: at(10, 5) },
      });
      await seedPing(log, { chatId: 'c1', previousId: first, startedAt: at(10, 55), usd: 0.01, taskSlug: 'a' });

      const totals = await controller.totals('step');
      expect(totals.by).toBe('step');
      expect(totals.lines).toEqual([expect.objectContaining({ key: 'implement', usd: 2 })]);
      const timeline = await controller.timeline('a');
      expect(timeline.entries.map((entry) => entry.kind)).toEqual(['new-chat', 'ping']);
      const warm = await controller.keepWarm('50', 'a');
      expect(warm).toEqual(expect.objectContaining({ ttlMinutes: 50, pings: 1 }));
    });
  });

  it('refuses a missing or double scope and a bad number', async () => {
    await withController(async (controller) => {
      await expect(controller.totals('nonsense')).rejects.toBeInstanceOf(BadRequestException);
      await expect(controller.timeline()).rejects.toBeInstanceOf(BadRequestException);
      await expect(controller.timeline('a', 'plan')).rejects.toBeInstanceOf(BadRequestException);
      expect(() => controller.keepWarm('0')).toThrow(BadRequestException);
    });
  });
});
