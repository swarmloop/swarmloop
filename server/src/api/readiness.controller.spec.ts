import 'reflect-metadata';
import type { ReadinessView } from '../contract/readiness';
import type { ReadinessService } from '../readiness/readiness.service';
import { createTestApp } from '../testing/test-app';
import { ReadinessController } from './readiness.controller';

describe('ReadinessController', () => {
  it('answers with the readiness report', async () => {
    const view: ReadinessView = {
      items: [{ id: 'docker', status: 'ok', line: 'docker answers', action: 'nothing to do' }],
      checkedAt: '2026-01-01T00:00:00.000Z',
    };
    const controller = new ReadinessController({ report: async () => view } as ReadinessService);
    await expect(controller.report(null)).resolves.toEqual(view);
  });

  it('passes the signed-in person to the report', async () => {
    const asked: (string | null | undefined)[] = [];
    const controller = new ReadinessController({
      report: async (login?: string | null) => {
        asked.push(login);
        return { items: [], checkedAt: null };
      },
    } as unknown as ReadinessService);
    await controller.report('alice');
    expect(asked).toEqual(['alice']);
  });

  it('boots with no model key and names the runtime in readiness', async () => {
    const app = await createTestApp({
      env: {
        AGENTS_PLAN: 'claude:m',
        AGENTS_IMPLEMENT: 'claude:m',
        AGENTS_REVIEW: 'claude:m',
        ANTHROPIC_API_KEY: '',
        CURSOR_API_KEY: '',
      },
    });
    try {
      const read = async (): Promise<ReadinessView> =>
        (await (await fetch(`${app.url}/readiness`, { headers: app.auth })).json()) as ReadinessView;
      let view = await read();
      while (view.items.length === 0) {
        await new Promise((flushed) => setImmediate(flushed));
        view = await read();
      }
      const { items } = view;
      expect(items.find((item) => item.id === 'model-credential')).toMatchObject({
        status: 'fail',
        link: '/connections#claude',
      });
    } finally {
      await app.close();
    }
  });
});
