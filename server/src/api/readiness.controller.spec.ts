import 'reflect-metadata';
import type { ReadinessView } from '../contract/api';
import type { ReadinessService } from '../readiness/readiness.service';
import { ReadinessController } from './readiness.controller';

describe('ReadinessController', () => {
  it('answers with the readiness report', async () => {
    const view: ReadinessView = {
      items: [{ id: 'docker', status: 'ok', line: 'docker answers', action: 'nothing to do' }],
    };
    const controller = new ReadinessController({ report: async () => view } as ReadinessService);
    await expect(controller.report()).resolves.toEqual(view);
  });
});
