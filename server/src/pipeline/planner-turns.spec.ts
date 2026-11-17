import type { RunEntity } from '../history/entities';
import type { PipelineResult } from '../core/pipeline-result';
import type { DocumentRepository } from '../history/document.repository';
import type { PlanChatEntry } from '../contract/plan-chat';
import type { PlanChatStore } from '../history/plan-chat.store';
import { PlannerTurns, type PlannerTurn } from './planner-turns';

const turn = (id: string, at: string): PlannerTurn => ({ id, at, text: `text of ${id}` });

describe('PlannerTurns', () => {
  it('starts one turn at a time per run and the next one only after the first ends', () => {
    const turns = new PlannerTurns();
    turns.offer('run-1', turn('a', '2026-01-01T00:00:00.000Z'));
    turns.offer('run-1', turn('b', '2026-01-01T00:00:01.000Z'));
    expect(turns.begin('run-1')?.id).toBe('a');
    expect(turns.replying('run-1')).toBe(true);
    expect(turns.begin('run-1')).toBeNull();
    turns.end('run-1');
    expect(turns.replying('run-1')).toBe(false);
    expect(turns.begin('run-1')?.id).toBe('b');
  });

  it('orders the turns of a run by the time of their entries, not by when they were offered', () => {
    const turns = new PlannerTurns();
    turns.offer('run-1', turn('late', '2026-01-01T00:00:05.000Z'));
    turns.offer('run-1', turn('early', '2026-01-01T00:00:01.000Z'));
    turns.offer('run-1', turn('same-as-late', '2026-01-01T00:00:05.000Z'));
    expect(turns.pending('run-1').map((held) => held.id)).toEqual(['early', 'late', 'same-as-late']);
  });

  it('holds a turn that is offered again once, also while it runs', () => {
    const turns = new PlannerTurns();
    turns.offer('run-1', turn('a', '2026-01-01T00:00:00.000Z'));
    turns.offer('run-1', turn('a', '2026-01-01T00:00:00.000Z'));
    expect(turns.pending('run-1')).toHaveLength(1);
    turns.begin('run-1');
    turns.offer('run-1', turn('a', '2026-01-01T00:00:00.000Z'));
    expect(turns.pending('run-1')).toEqual([]);
  });

  it('keeps the runs apart', () => {
    const turns = new PlannerTurns();
    turns.offer('run-1', turn('a', '2026-01-01T00:00:00.000Z'));
    turns.offer('run-2', turn('b', '2026-01-01T00:00:00.000Z'));
    expect(turns.begin('run-1')?.id).toBe('a');
    expect(turns.begin('run-2')?.id).toBe('b');
    expect(turns.begin('run-3')).toBeNull();
  });
});

const message = (key: string, at: string): PlanChatEntry => ({
  key,
  role: 'person',
  text: `text of ${key}`,
  at,
  state: 'pending',
});
const ok: PipelineResult = { exitCode: 0, message: 'plan done' };

/** The turns of a run whose plan chat holds `pending` and whose plan decision is `decision`. */
function amending(pending: PlanChatEntry[], decision: 'approve' | null) {
  const left = [...pending];
  const chat = { pending: () => Promise.resolve([...left]) } as unknown as PlanChatStore;
  const body = JSON.stringify({ plan: { name: '', overview: '', items: ['a'], decision } });
  const documents = { latestBody: () => Promise.resolve(body) } as unknown as DocumentRepository;
  return { turns: new PlannerTurns(chat, documents), take: () => left.splice(0) };
}

describe('PlannerTurns.takesMessages', () => {
  const run = (split: boolean, currentStep: string, parent = false) =>
    ({ split, currentStep, workspace: 'ready', parentRunId: parent ? 7 : null }) as unknown as RunEntity;

  it('takes the message of a run after implement started, split or not', () => {
    const { turns } = amending([], null);
    expect(turns.takesMessages(run(true, 'implement'))).toBe(true);
    expect(turns.takesMessages(run(false, 'checks'))).toBe(true);
  });

  it('does not take it before implement or for a subtask', () => {
    const { turns } = amending([], null);
    expect(turns.takesMessages(run(true, 'plan'))).toBe(false);
    expect(turns.takesMessages(run(true, 'implement', true))).toBe(false);
  });
});

describe('PlannerTurns taking a turn', () => {
  it('runs the visit for the messages that wait and tells whether the plan changed', async () => {
    const kept = amending([message('a', '2026-01-01T00:00:00.000Z')], 'approve');
    expect(await kept.turns.take('run-1', async () => (kept.take(), ok), new Set())).toBe('kept');
    const changed = amending([message('a', '2026-01-01T00:00:00.000Z')], null);
    expect(await changed.turns.take('run-1', async () => (changed.take(), ok), new Set())).toBe('changed');
    expect(changed.turns.replying('run-1')).toBe(false);
  });

  it('does nothing when no message waits', async () => {
    const { turns } = amending([], 'approve');
    expect(await turns.take('run-1', () => Promise.reject(new Error('must not run')), new Set())).toBe('none');
  });

  it('takes one turn at a time: a second take while the visit runs does nothing', async () => {
    const { turns, take } = amending([message('a', '2026-01-01T00:00:00.000Z')], 'approve');
    let release: () => void = () => undefined;
    const first = turns.take(
      'run-1',
      () =>
        new Promise<PipelineResult>((resolve) => {
          release = () => {
            take();
            resolve(ok);
          };
        }),
      new Set(),
    );
    await Promise.resolve();
    expect(turns.replying('run-1')).toBe(true);
    expect(await turns.take('run-1', () => Promise.reject(new Error('must not run')), new Set())).toBe('none');
    release();
    expect(await first).toBe('kept');
  });

  it('keeps a message pending when the planner gave no usable reply, and does not ask for it again in the same drive', async () => {
    const { turns } = amending([message('a', '2026-01-01T00:00:00.000Z')], 'approve');
    const declined = new Set<string>();
    const failed: PipelineResult = { exitCode: 1, message: 'plan failed' };
    expect(await turns.take('run-1', () => Promise.resolve(failed), declined)).toBe('none');
    expect([...declined]).toEqual(['a']);
    expect(await turns.take('run-1', () => Promise.reject(new Error('must not run')), declined)).toBe('none');
    expect(turns.pending('run-1')).toEqual([]);
  });
});

describe('PlannerTurns background passes', () => {
  it('waits for a pass that is still running when the module closes', async () => {
    const turns = new PlannerTurns();
    const ended: string[] = [];
    let finish: () => void = () => undefined;
    turns.background(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            ended.push('pass');
            resolve();
          };
        }),
    );
    const closing = turns.onModuleDestroy().then(() => ended.push('closed'));
    await Promise.resolve();
    expect(ended).toEqual([]);
    finish();
    await closing;
    expect(ended).toEqual(['pass', 'closed']);
  });

  it('does not let a failed pass break the close', async () => {
    const turns = new PlannerTurns();
    turns.background(() => Promise.reject(new Error('host down')));
    await expect(turns.onModuleDestroy()).resolves.toBeUndefined();
  });
});
