import 'reflect-metadata';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { createTestApp, type TestApp } from './test-app';

const KEY = 'PROJ-76';

describe('a paused server', () => {
  let app: TestApp;

  afterEach(async () => {
    await app.close();
  });

  const send = (method: string, path: string, headers: Record<string, string> = app.auth) =>
    fetch(`${app.url}${path}`, { method, headers });
  const health = async () => (await send('GET', '/health')).json();

  it('answers the pause routes only to a caller that is let in, and says so on /health', async () => {
    app = await createTestApp();
    expect((await send('POST', '/server/pause', {})).status).toBe(401);
    expect((await send('POST', '/server/pause', await app.personToken('mia'))).status).toBe(403);
    expect((await send('DELETE', '/server/pause', await app.personToken('mia'))).status).toBe(403);
    expect(await health()).toEqual({ status: 'ok', paused: false, containers: 0 });

    const paused = await send('POST', '/server/pause');
    expect(await paused.json()).toEqual({ paused: true });
    expect(await health()).toEqual({ status: 'ok', paused: true, containers: 0 });

    const resumed = await send('DELETE', '/server/pause');
    expect(await resumed.json()).toEqual({ paused: false });
    expect(await health()).toEqual({ status: 'ok', paused: false, containers: 0 });
  });

  it('lets a step that starts no container go on while paused', async () => {
    app = await createTestApp();
    await send('POST', '/server/pause');
    const waiting = await app.app.get(RunRepository).openWaiting(KEY, '');
    waiting.currentStep = 'research';
    await app.app.get(RunRepository).saveRun(waiting);
    await app.app.get(DocumentRepository).putDocument(waiting, 'requirements', '{"prompt":"Ship the field"}\n');
    await app.pipeline.startDetached(KEY, {}, 'research');
    await app.pipeline.whenIdle(KEY);
    expect(app.runner.steps).toContain('research');
  });

  it('is not paused after a restart', async () => {
    app = await createTestApp();
    await send('POST', '/server/pause');
    app = await app.restart();
    expect(await health()).toEqual({ status: 'ok', paused: false, containers: 0 });
  });
});
