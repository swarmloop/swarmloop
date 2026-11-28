import type { Logger } from '@nestjs/common';
import { ARTIFACTS } from '../steps/contract/artifacts';
import type { RunEntity } from '../history/entities';
import type { DocumentRepository } from '../history/document.repository';
import type { RunRepository } from '../history/run.repository';
import { writeRunState } from '../history/run-state';
import type { RebaseEvent, SubtaskMergeRequest } from '../steps/shared/subtask-ops';
import type { RunRebase } from '../steps/run-rebase';
import type { CommandService } from './command.service';
import { SubtaskRebases } from './subtask-rebases';

const EVENT: RebaseEvent = { tip: 'web@abc', note: 'rebased onto the epic' };
const REQUEST: SubtaskMergeRequest = { repo: 'web', project: 'acme/web', iid: 1 };

interface Setup {
  accepted: { payload: Record<string, unknown>; key: string | undefined }[];
  documents: Map<string, string>;
  rebases: SubtaskRebases;
  /** The types of the commands accepted and not yet run. */
  pending: Set<string>;
  /** The arguments of each Rebase the catch-up ran. */
  moves: unknown[][];
}

/** The rebase commands of one part with the given state, worktrees and merge requests; `asking` says it waits on a question. */
function setup(
  options: {
    worktrees?: boolean;
    requests?: SubtaskMergeRequest[];
    asking?: boolean;
    tip?: string | null;
    dead?: string[];
    newest?: { idempotencyKey: string | null; state: string; result?: string | null } | null;
    rebaser?: boolean;
    outage?: boolean;
  } = {},
): Setup {
  const { worktrees = true, requests = [], asking = false, tip = 'web@def', dead = [], newest = null } = options;
  const { rebaser = false, outage = false } = options;
  const pending = new Set<string>();
  const moves: unknown[][] = [];
  const documents = new Map<string, string>(worktrees ? [[ARTIFACTS.repos.kind, 'web']] : []);
  const accepted: Setup['accepted'] = [];
  const commands = {
    accept: (_type: string, _key: string, payload: Record<string, unknown>, options?: { idempotencyKey?: string }) => {
      const key = options?.idempotencyKey;
      accepted.push({ payload, key });
      pending.add('rebase');
      const died = key !== undefined && dead.includes(key);
      return Promise.resolve({ replayed: died, command: { state: died ? 'failed' : 'done', id: 7 } });
    },
    latestOfRun: () => Promise.resolve(newest),
    hasPending: (_run: RunEntity, type: string) => Promise.resolve(pending.has(type)),
  } as unknown as CommandService;
  const store = {
    latestBody: (_key: string, kind: string) => Promise.resolve(documents.get(kind) ?? null),
    putDocument: (_run: RunEntity, kind: string, body: string) => {
      documents.set(kind, body);
      return Promise.resolve();
    },
  } as unknown as DocumentRepository;
  const rebases = new SubtaskRebases(
    {} as RunRepository,
    store,
    commands,
    rebaser
      ? ({
          rebase: (...args: unknown[]) => {
            moves.push(args);
            return outage ? Promise.reject(new Error('host is down')) : Promise.resolve('stay');
          },
        } as unknown as RunRebase)
      : undefined,
    () => Promise.resolve(asking),
    () => Promise.resolve(requests),
    () => Promise.resolve(tip),
    { warn: () => undefined } as unknown as Logger,
  );
  return { accepted, documents, rebases, pending, moves };
}

function part(change: Parameters<typeof writeRunState>[1]): RunEntity {
  const run = { key: 'f1-a', revision: 1, generation: 1, stateReason: null, mergeOutcome: null } as RunEntity;
  writeRunState(run, change);
  return run;
}

const waitingForSibling = part({
  status: 'waiting',
  currentStep: 'research',
  reason: { code: 'SUBTASK_WAITING', message: 'waits for a sibling' },
});
const waitingForAnswer = part({ status: 'waiting', currentStep: 'research', facts: { needsAnswers: true } });

describe('SubtaskRebases', () => {
  it.each([
    ['a sibling', waitingForSibling, false],
    ['a question', waitingForAnswer, true],
  ])('moves a part that waits on %s, with an event or without, and keeps its wait', async (_name, run, asking) => {
    for (const event of [EVENT, undefined]) {
      const { accepted, rebases, documents } = setup({ asking });
      expect(await rebases.rebase(run, event)).toBe(false);
      expect(accepted.map((sent) => sent.payload)).toEqual([{ byParent: true, keepsWait: true }]);
      expect(documents.has(ARTIFACTS.handoff.kind)).toBe(event !== undefined);
    }
  });

  it('moves no part that waits when it has no worktrees yet', async () => {
    const { accepted, rebases } = setup({ worktrees: false });
    expect(await rebases.rebase(waitingForSibling, EVENT)).toBe(false);
    expect(accepted).toEqual([]);
  });

  it('moves a stopped part never', async () => {
    const stopped = part({
      status: 'failed',
      currentStep: 'implement',
      reason: { code: 'STOPPED', message: 'stopped' },
    });
    const { accepted, rebases } = setup({ requests: [REQUEST] });
    expect(await rebases.rebase(stopped, EVENT)).toBe(false);
    expect(accepted).toEqual([]);
  });

  it('moves a blocked part for an event only, with the plain payload', async () => {
    const blocked = part({ status: 'blocked', currentStep: 'checks', reason: { code: 'CHECK_FAILED', message: 'no' } });
    const { accepted, rebases } = setup();
    expect(await rebases.rebase(blocked)).toBe(false);
    expect(accepted).toEqual([]);
    expect(await rebases.rebase(blocked, EVENT)).toBe(true);
    expect(accepted.map((sent) => sent.payload)).toEqual([{ byParent: true }]);
  });

  it('sends an idle part with a merge request the plain payload and says it goes on', async () => {
    const { accepted, rebases } = setup({ requests: [REQUEST] });
    expect(await rebases.rebase(part({ status: 'done', currentStep: 'pipeline' }))).toBe(true);
    expect(accepted.map((sent) => sent.payload)).toEqual([{ byParent: true }]);
  });

  it('queues the move of a running part for its next step and sends it nothing', async () => {
    const { accepted, rebases, documents } = setup();
    expect(await rebases.rebase(part({ status: 'running', currentStep: 'implement' }), EVENT)).toBe(true);
    expect(accepted).toEqual([]);
    expect(documents.get(ARTIFACTS.pendingRebase.kind)).toBe(EVENT.note);
  });

  it('keys the plain move by the parent tip it moves onto', async () => {
    const { accepted, rebases } = setup({ requests: [REQUEST], tip: 'web@def' });
    await rebases.rebase(part({ status: 'done', currentStep: 'pipeline' }));
    expect(accepted.map((sent) => sent.key)).toEqual(['subtask-rebase-f1-a-web@def']);
  });

  it('sends the plain move once for one parent tip: a second pass sends the same key', async () => {
    const { accepted, rebases } = setup({ requests: [REQUEST], tip: 'web@def' });
    const run = part({ status: 'done', currentStep: 'pipeline' });
    await rebases.rebase(run);
    await rebases.rebase(run);
    expect(new Set(accepted.map((sent) => sent.key))).toEqual(new Set(['subtask-rebase-f1-a-web@def']));
  });

  it('sends the plain move again under a new key when its command at that tip died', async () => {
    const { accepted, rebases } = setup({ requests: [REQUEST], tip: 'web@def', dead: ['subtask-rebase-f1-a-web@def'] });
    await rebases.rebase(part({ status: 'done', currentStep: 'pipeline' }));
    expect(accepted.map((sent) => sent.key)).toEqual([
      'subtask-rebase-f1-a-web@def',
      'subtask-rebase-f1-a-web@def-after-7',
    ]);
  });

  it('sends no move when the parent has no tip', async () => {
    const { accepted, rebases } = setup({ requests: [REQUEST], tip: null });
    expect(await rebases.rebase(part({ status: 'done', currentStep: 'pipeline' }))).toBe(false);
    expect(await rebases.rebase(part({ status: 'done', currentStep: 'pipeline' }), undefined)).toBe(false);
    expect(accepted).toEqual([]);
  });

  it('reads a run as moving while its rebase command has not run', async () => {
    const run = part({ status: 'done', currentStep: 'pipeline' });
    const { rebases, pending } = setup({ requests: [REQUEST], tip: 'web@def' });
    expect(await rebases.moving(run)).toBe(false);
    await rebases.rebase(run);
    expect(await rebases.moving(run)).toBe(true);
    pending.clear();
    expect(await rebases.moving(run)).toBe(false);
  });

  it('catches a child up through its Rebase, leaving a conflict parked for its implement agent', async () => {
    const { rebases, moves } = setup({ rebaser: true });
    await rebases.catchUp(part({ status: 'waiting', currentStep: 'research' }));
    expect(moves).toEqual([['f1-a', false, true, false, true]]);
    const failing = setup({ rebaser: true, outage: true });
    await expect(failing.rebases.catchUp(part({ status: 'waiting', currentStep: 'research' }))).rejects.toThrow(
      'host is down',
    );
  });

  describe('the move of a part that its parent sent', () => {
    const MOVE = 'subtask-rebase-f1-a-web@def';
    const moveOf = (newest: NonNullable<Parameters<typeof setup>[0]>['newest']) =>
      setup({ newest }).rebases.moveOf(part({ status: 'blocked', currentStep: 'checks' }));

    it.each(['accepted', 'executing'])('reads moving while the move is %s', async (state) => {
      expect(await moveOf({ idempotencyKey: MOVE, state })).toEqual({ kind: 'moving' });
    });

    it('reads failed with the error the move stored once it failed', async () => {
      const result = JSON.stringify({ error: { message: 'push refused' } });
      expect(await moveOf({ idempotencyKey: MOVE, state: 'failed', result })).toEqual({
        kind: 'failed',
        reason: 'push refused',
      });
    });

    it('reads nothing for a move that succeeded, for a part with no command and for another command', async () => {
      expect(await moveOf({ idempotencyKey: MOVE, state: 'succeeded' })).toBeNull();
      expect(await moveOf(null)).toBeNull();
      expect(await moveOf({ idempotencyKey: 'resume-1', state: 'accepted' })).toBeNull();
      expect(await moveOf({ idempotencyKey: null, state: 'failed' })).toBeNull();
    });

    it('reads nothing for a part that is not blocked or failed: its own state tells what it is', async () => {
      const running = setup({ newest: { idempotencyKey: MOVE, state: 'executing' } });
      expect(await running.rebases.moveOf(part({ status: 'done', currentStep: 'pipeline' }))).toBeNull();
    });
  });

  it('says a part keeps its wait only while it waits on a question or a sibling', async () => {
    const { rebases } = setup();
    expect(await rebases.keepsWait(waitingForSibling)).toBe(true);
    expect(await rebases.keepsWait(part({ status: 'done', currentStep: 'pipeline' }))).toBe(false);
  });
});
