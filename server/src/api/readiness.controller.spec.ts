import 'reflect-metadata';
import type { ReadinessView } from '../contract/readiness';
import type { ReadinessService } from '../readiness/readiness.service';
import { ReadinessController } from './readiness.controller';

describe('ReadinessController', () => {
  it('answers with the readiness report', async () => {
    const view: ReadinessView = {
      items: [{ id: 'docker', status: 'ok', line: 'docker answers', action: 'nothing to do' }],
      checkedAt: '2026-01-01T00:00:00.000Z',
      load: null,
    };
    const controller = new ReadinessController({ report: async () => view } as ReadinessService);
    await expect(controller.report()).resolves.toEqual(view);
  });
});
