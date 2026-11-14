import 'reflect-metadata';
import type { ReadinessView } from '../contract/readiness';
import { RunRepository } from '../history/run.repository';
import { ReadinessService } from '../readiness/readiness.service';
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

  it('starts with no .env and no model key, answers health, names the runtime and refuses a new run', async () => {
    const app = await createTestApp({ envFile: false });
    try {
      // The first pass is started and awaited here; the request below reads its report, which the fake clock keeps fresh.
      await app.app.get(ReadinessService).report();
      expect((await fetch(`${app.url}/health`)).status).toBe(200);
      const view = (await (await fetch(`${app.url}/readiness`, { headers: app.auth })).json()) as ReadinessView;
      const credential = view.items.find((item) => item.id === 'model-credential');
      expect(credential).toMatchObject({ status: 'fail', link: '/connections#claude' });
      expect(credential?.action).toBe('connect claude in Connections');

      const refused = await fetch(`${app.url}/runs`, {
        method: 'POST',
        headers: { ...app.auth, 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'PROJ-600', prompt: 'Ship it', projects: ['demo'] }),
      });
      expect(refused.status).toBe(422);
      expect(await refused.text()).toContain('claude');
      expect(await app.app.get(RunRepository).findRun('PROJ-600')).toBeNull();
    } finally {
      await app.close();
    }
  });
});
