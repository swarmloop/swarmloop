import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, runLog } from './api';
import {
  createRun,
  getFlow,
  getHistory,
  getRunLog,
  getStep,
  listProjects,
  listRuns,
  rebaseRun,
  removeRun,
  replayStep,
  resumeRun,
  sendAnswers,
  setRunProjects,
  startReviewer,
  stopRun,
} from './endpoints';

vi.mock('./api', () => ({ api: vi.fn(), runLog: vi.fn() }));

beforeEach(() => {
  vi.mocked(api).mockReset();
});

describe('endpoints', () => {
  it('reads with GET paths and encodes the key once', async () => {
    await listRuns();
    await getFlow('a/b');
    await getStep('run-1', 'code review');
    await getHistory('run-1');
    await listProjects();

    expect(vi.mocked(api).mock.calls).toEqual([
      ['/runs'],
      ['/runs/a%2Fb'],
      ['/runs/run-1/steps/code%20review'],
      ['/runs/run-1/history'],
      ['/checkouts/projects'],
    ]);
  });

  it('posts the body of createRun, sendAnswers, setRunProjects and replayStep as JSON', async () => {
    await createRun({ prompt: 'p', phases: ['requirements'], projects: ['x'] });
    await sendAnswers('run-1', { answers: [{ kind: 'question', id: 'q1', body: 'yes' }] });
    await setRunProjects('run-1', 'docs');
    await replayStep('run-1', 'implement', { prompt: 'again', phases: ['implementation'] });

    expect(vi.mocked(api).mock.calls).toEqual([
      ['/runs', { method: 'POST', body: JSON.stringify({ prompt: 'p', phases: ['requirements'], projects: ['x'] }) }],
      [
        '/runs/run-1/answers',
        { method: 'POST', body: JSON.stringify({ answers: [{ kind: 'question', id: 'q1', body: 'yes' }] }) },
      ],
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
    await startReviewer('run-1', 'code-review-quality');
    await removeRun('run-1');

    expect(vi.mocked(api).mock.calls).toEqual([
      ['/runs/run-1/resume', { method: 'POST' }],
      ['/runs/run-1/stop', { method: 'POST' }],
      ['/runs/run-1/rebase', { method: 'POST' }],
      ['/runs/run-1/steps/code-review-quality', { method: 'POST' }],
      ['/runs/run-1', { method: 'DELETE' }],
    ]);
  });

  it('reads a run log through runLog', async () => {
    vi.mocked(runLog).mockResolvedValue('notes');

    await expect(getRunLog('run-1', 'code-review-quality')).resolves.toBe('notes');
    expect(runLog).toHaveBeenCalledWith('run-1', 'code-review-quality');
  });
});
