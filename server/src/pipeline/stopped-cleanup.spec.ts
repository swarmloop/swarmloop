import 'reflect-metadata';
import type { AppConfig } from '../config/env';
import { StoppedCleanup } from './stopped-cleanup';

type Answer = 'gone' | 'unknown' | Error;

function world(marks: Record<string, string>, answers: Record<string, Answer>, resumed: string[] = []) {
  const stoppedRun = { status: 'blocked', stateReason: JSON.stringify({ code: 'STOPPED', message: 'stopped' }) };
  const runs = Object.keys(marks).map((key, index) => ({
    id: index + 1,
    key,
    ...(resumed.includes(key) ? { status: 'running', stateReason: null } : stoppedRun),
  }));
  const cleared: string[] = [];
  const stopped: string[] = [];
  const cleanup = new StoppedCleanup(
    { listRuns: async () => runs } as never,
    {
      latestDocuments: async () => runs.map(({ id, key }) => ({ runId: id, body: marks[key] })),
      putDocument: async (run: { key: string }, _kind: string, body: string) => {
        if (body === '') cleared.push(run.key);
      },
    } as never,
    {
      stopRun: async (key: string) => {
        stopped.push(key);
        const answer = answers[key] ?? 'gone';
        if (answer instanceof Error) throw answer;
        return answer;
      },
    } as never,
    { env: { STOP_GRACE_S: 10 } } as unknown as AppConfig,
  );
  return { cleanup, cleared, stopped };
}

describe('StoppedCleanup', () => {
  it('keeps the document while docker does not answer and clears it once the containers are gone', async () => {
    const silent = world({ 'KEY-1': 'implement' }, { 'KEY-1': 'unknown' });
    await silent.cleanup.run();
    expect(silent.cleared).toEqual([]);

    const answering = world({ 'KEY-1': 'implement' }, {});
    await answering.cleanup.run();
    expect(answering.cleared).toEqual(['KEY-1']);
  });

  it('never touches a run whose document is empty', async () => {
    const found = world({ 'KEY-1': '', 'KEY-2': 'implement' }, {});
    await found.cleanup.run();
    expect(found.stopped).toEqual(['KEY-2']);
  });

  it('does not touch a run that was resumed after its Stop, and drops the document', async () => {
    const found = world({ 'KEY-1': 'implement', 'KEY-2': 'implement' }, {}, ['KEY-1']);
    await found.cleanup.run();
    expect(found.stopped).toEqual(['KEY-2']);
    expect(found.cleared).toEqual(['KEY-1', 'KEY-2']);
  });

  it('goes on with the other runs when one fails', async () => {
    const found = world({ 'KEY-1': 'implement', 'KEY-2': 'implement' }, { 'KEY-1': new Error('boom') });
    await found.cleanup.run();
    expect(found.cleared).toEqual(['KEY-2']);
  });
});
