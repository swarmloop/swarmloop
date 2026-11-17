import { createTestApp, type TestApp } from '../testing/test-app';

describe('the run log route for a signed-in person', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await createTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  const status = async (path: string): Promise<number> => {
    const response = await fetch(`${app.url}${path}`, { headers: app.auth });
    return response.status;
  };

  it('answers 404 for a run and a step that do not exist', async () => {
    expect(await status('/runs/nope/steps/plan/log')).toBe(404);
  });

  it('answers 404 for keys and steps that climb out of the log folder', async () => {
    expect(await status('/runs/..%2F..%2Fetc/steps/plan/log')).toBe(404);
    expect(await status('/runs/nope/steps/..%2F..%2Fpasswd/log')).toBe(404);
    expect(await status('/runs/%2e%2e/steps/plan/log')).toBe(404);
  });
});
