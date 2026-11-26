import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, runLog } from './api';
import {
  createRun,
  disconnectIntegration,
  getDoneLately,
  getFlow,
  getIntegrationCards,
  getSignIn,
  saveIntegration,
  sendSignInCode,
  startSignIn,
  testIntegration,
  getHistory,
  getProviders,
  getSession,
  logout,
  getRunLog,
  getStats,
  getStep,
  getStepEvents,
  listProjects,
  listRemote,
  createRepository,
  listRuns,
  rebaseRun,
  removeRun,
  replayStep,
  resumeRun,
  sendPlanChat,
  setRunProjects,
  stopRun,
  uploadFile,
} from './endpoints';

vi.mock('./api', () => ({ api: vi.fn(), runLog: vi.fn() }));

beforeEach(() => {
  vi.mocked(api).mockReset();
});

describe('endpoints', () => {
  it('asks for a page of 500 events of one step or of the whole run', async () => {
    vi.mocked(api).mockResolvedValue({ events: [], next: null });

    await getStepEvents('r 1', 'plan', 7);
    await getStepEvents('r 1', null, 0);

    expect(vi.mocked(api).mock.calls).toEqual([
      ['/runs/r%201/events?step=plan&after=7&limit=500'],
      ['/runs/r%201/events?after=0&limit=500'],
    ]);
  });

  it('uploads a file as a raw body with its encoded name', async () => {
    const file = new Blob(['bytes']);
    vi.mocked(api).mockResolvedValue({ id: 'u1', name: 'a b.png', size: 5 });

    await expect(uploadFile(file, 'a b.png')).resolves.toEqual({ id: 'u1', name: 'a b.png', size: 5 });

    expect(vi.mocked(api).mock.calls).toEqual([
      [
        '/uploads?name=a%20b.png',
        { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } },
      ],
    ]);
  });

  it('throws the reason of a refused upload', async () => {
    vi.mocked(api).mockRejectedValue(new Error('The file is larger than 25 MB'));

    await expect(uploadFile(new Blob(['x']), 'big.bin')).rejects.toThrow('The file is larger than 25 MB');
  });

  it('posts a plan chat message to the run, with upload ids only when there are some', async () => {
    await sendPlanChat('a/b', 'split it', ['u1']);
    await sendPlanChat('run-1', 'hello');

    expect(vi.mocked(api).mock.calls).toEqual([
      ['/runs/a%2Fb/plan-chat', { method: 'POST', body: JSON.stringify({ message: 'split it', attachments: ['u1'] }) }],
      ['/runs/run-1/plan-chat', { method: 'POST', body: JSON.stringify({ message: 'hello' }) }],
    ]);
  });

  it('reads the items of Done lately from its own route', async () => {
    await getDoneLately();

    expect(vi.mocked(api).mock.calls).toEqual([['/overview/done']]);
  });

  it('reads with GET paths and encodes the key once', async () => {
    await listRuns({ part: 'done', q: 'a b', cursor: 'c1' });
    await listRuns({ part: 'active', q: '' });
    await getFlow('a/b');
    await getStep('run-1', 'code review');
    await getHistory('run-1');
    await listProjects();
    await getStats(7, -60);

    expect(vi.mocked(api).mock.calls).toEqual([
      ['/runs?part=done&q=a+b&cursor=c1'],
      ['/runs?part=active'],
      ['/runs/a%2Fb'],
      ['/runs/run-1/steps/code%20review'],
      ['/runs/run-1/history'],
      ['/checkouts/projects'],
      ['/stats?days=7&tz=-60'],
    ]);
  });

  it('reads the remote repositories and posts a new repository to the swarmloop API', async () => {
    await listRemote();
    await createRepository({ host: 'github', owner: 'acme', name: 'demo', public: false });

    expect(vi.mocked(api).mock.calls).toEqual([
      ['/checkouts/remote'],
      [
        '/checkouts/repositories',
        { method: 'POST', body: JSON.stringify({ host: 'github', owner: 'acme', name: 'demo', public: false }) },
      ],
    ]);
  });

  it('posts the body of createRun, setRunProjects and replayStep as JSON', async () => {
    await createRun({ prompt: 'p', phases: ['requirements'], projects: ['x'] });
    await setRunProjects('run-1', 'docs');
    await replayStep('run-1', 'implement', { prompt: 'again', phases: ['implementation'] });

    expect(vi.mocked(api).mock.calls).toEqual([
      ['/runs', { method: 'POST', body: JSON.stringify({ prompt: 'p', phases: ['requirements'], projects: ['x'] }) }],
      ['/runs/run-1/projects', { method: 'POST', body: JSON.stringify({ name: 'docs' }) }],
      [
        '/runs/run-1/steps/implement/replay',
        { method: 'POST', body: JSON.stringify({ prompt: 'again', phases: ['implementation'] }) },
      ],
    ]);
  });

  it('posts the bodyless actions and deletes a run', async () => {
    await resumeRun('run-1');
    await stopRun('run-1');
    await rebaseRun('run-1');
    await removeRun('run-1');

    expect(vi.mocked(api).mock.calls).toEqual([
      ['/runs/run-1/resume', { method: 'POST' }],
      ['/runs/run-1/stop', { method: 'POST' }],
      ['/runs/run-1/rebase', { method: 'POST' }],
      ['/runs/run-1', { method: 'DELETE' }],
    ]);
  });

  it('reads the login providers and the session, and logs out with a POST', async () => {
    await getProviders();
    await getSession();
    await logout();

    expect(vi.mocked(api).mock.calls).toEqual([
      ['/auth/providers'],
      ['/auth/me'],
      ['/auth/logout', { method: 'POST' }],
    ]);
  });

  it('calls the integration routes with the id and the session encoded once', async () => {
    await getIntegrationCards();
    await saveIntegration('claude', { key: 'k' });
    await testIntegration('claude');
    await disconnectIntegration('a b');
    await startSignIn('claude');
    await sendSignInCode('claude', 's/1', '123');
    await getSignIn('claude', 's/1');

    expect(vi.mocked(api).mock.calls).toEqual([
      ['/connections/integrations'],
      ['/connections/integrations/claude', { method: 'PUT', body: '{"fields":{"key":"k"}}' }],
      ['/connections/integrations/claude/test', { method: 'POST' }],
      ['/connections/integrations/a%20b', { method: 'DELETE' }],
      ['/connections/integrations/claude/sign-in', { method: 'POST' }],
      ['/connections/integrations/claude/sign-in/s%2F1/code', { method: 'POST', body: '{"code":"123"}' }],
      ['/connections/integrations/claude/sign-in/s%2F1'],
    ]);
  });

  it('reads a run log through runLog', async () => {
    vi.mocked(runLog).mockResolvedValue('notes');

    await expect(getRunLog('run-1', 'code-review-quality')).resolves.toBe('notes');
    expect(runLog).toHaveBeenCalledWith('run-1', 'code-review-quality', undefined, undefined);
  });
});
