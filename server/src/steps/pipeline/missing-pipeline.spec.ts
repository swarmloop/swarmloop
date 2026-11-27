import { ConflictException } from '@nestjs/common';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ERROR_CODES } from '../../contract/error-codes';
import { HostUnavailable } from '../../core/swarmloop-error';
import type { CodeHost, PipelineRef } from '../../integrations/code-host/code-host';
import { featureWorktree, git } from '../../testing/runs.spec-helpers';
import type { StepContext } from '../base-step';
import { ARTIFACTS } from '../contract/artifacts';
import { CI_LOOK_MS } from './ci-not-started';
import { missingPipeline } from './missing-pipeline';

const KEY = 'PROJ-900';
const NOW = Date.parse('2026-11-27T10:00:00.000Z');
const RETRY_AT = new Date(NOW + CI_LOOK_MS).toISOString();
const TIPS = 'demo@tip2';
const HOST_TEXT = 'the merge request has conflicts';

interface FakeRun {
  key: string;
  attemptsPipeline: number;
  status: string;
  currentStep: string;
  stateReason: string | null;
  ownerInstance: string | null;
  activeAttempt: string | null;
  stepStartedAt: string | null;
}

function setup(options: { code?: 'merge-conflict' | null; history?: string[]; attempts?: number; idle?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'swarmloop-missing-pipeline-'));
  const { tree } = featureWorktree(root, KEY);
  git(tree, ['remote', 'set-url', 'origin', 'https://gitlab.example/group/demo.git']);
  const head = git(tree, ['rev-parse', 'HEAD']);
  const branch = git(tree, ['branch', '--show-current']);
  const ref: PipelineRef = { project: 'group/demo', ref: branch, sha: head };
  const run: FakeRun = {
    key: KEY,
    attemptsPipeline: options.attempts ?? 0,
    status: 'running',
    currentStep: 'pipeline',
    stateReason: null,
    ownerInstance: null,
    activeAttempt: null,
    stepStartedAt: 'x',
  };
  const store = new Map<string, string>([
    [ARTIFACTS.repos.kind, 'demo\n'],
    [ARTIFACTS.pipelineRebases.kind, JSON.stringify(options.history ?? [])],
  ]);
  const ctx = {
    opened: { run, startedAt: '2026-11-27T10:00:00.000Z' },
    calls: [],
    clock: { now: () => NOW, iso: () => new Date(NOW).toISOString() },
    reread: async (artifact: { kind: string }) => {
      const value = store.get(artifact.kind);
      if (value === undefined) return null;
      return artifact.kind === ARTIFACTS.repos.kind ? value.split('\n').filter(Boolean) : value;
    },
    write: async (artifact: { kind: string }, value: string) => void store.set(artifact.kind, value),
  } as unknown as StepContext;
  const host = {
    diagnoseMissingPipeline: async () => ({
      code: options.code === undefined ? 'merge-conflict' : options.code,
      reason: HOST_TEXT,
      httpCalls: [],
    }),
  } as unknown as CodeHost;
  const runs = {
    change: async (_key: string, fn: (fresh: FakeRun) => void) => fn(run),
  };
  const rebase = {
    rebase: jest.fn(async (): Promise<'start' | 'resume' | 'resolve'> => 'start'),
    subtasksIdle: jest.fn(async () => options.idle ?? true),
    baseTips: jest.fn(async () => TIPS),
    handHostConflict: jest.fn(async (): Promise<'resolve'> => {
      run.status = 'waiting';
      run.currentStep = 'implement';
      return 'resolve';
    }),
  };
  const events = { recordLoop: jest.fn(async () => undefined) };
  const call = (halted = false) =>
    missingPipeline({
      ctx,
      runs: runs as never,
      events: events as never,
      rebase,
      halted: () => halted,
      root,
      limit: 6,
      host,
      records: [ref],
      seen: [{ project: 'group/demo', runs: [] }] as never,
      missing: ['demo'],
    });
  const recorded = (): string[] => JSON.parse(store.get(ARTIFACTS.pipelineRebases.kind) ?? '[]') as string[];
  return { root, tree, head, run, rebase, call, recorded, store, events };
}

const ENDED = { exitCode: 0, message: '' } as never;
const reasonOf = (run: FakeRun): { code: string; retryAt?: string } =>
  JSON.parse(run.stateReason ?? '{}') as { code: string; retryAt?: string };

describe('missingPipeline for a conflict that keeps CI from starting', () => {
  it('rebases a conflicted head whose base tip is new and records its key after the move', async () => {
    const t = setup({ history: ['group/demo@somewhere@demo@tip1'] });
    const result = await t.call();
    expect(result.route).toEqual(expect.objectContaining({ to: 'wait', code: ERROR_CODES.CI_NOT_STARTED }));
    expect(t.run.attemptsPipeline).toBe(1);
    expect(t.recorded()).toHaveLength(1);
    await result.afterClose!(ENDED);
    expect(t.rebase.rebase).toHaveBeenCalledWith(KEY, false, false, false, false, HOST_TEXT);
    expect(t.recorded()).toEqual(['group/demo@somewhere@demo@tip1', `group/demo@${t.head}@${TIPS}`]);
  });

  it('waits with the next look and records no key before the move ran', async () => {
    const t = setup({});
    const result = await t.call();
    expect(result.route).toEqual(
      expect.objectContaining({
        reason: `automatic rebase; next look at ${RETRY_AT}`,
        retryAt: RETRY_AT,
      }),
    );
    expect(t.recorded()).toEqual([]);
  });

  it('hands the host text to implement when this head was tried on this base tip', async () => {
    const t = setup({});
    t.store.set(ARTIFACTS.pipelineRebases.kind, JSON.stringify([`group/demo@${t.head}@${TIPS}`]));
    const result = await t.call();
    expect(result.route).toEqual(
      expect.objectContaining({
        reason: `merge conflict sent to the implement agent; next look at ${RETRY_AT}`,
        code: ERROR_CODES.CI_NOT_STARTED,
      }),
    );
    expect(t.run.attemptsPipeline).toBe(0);
    await result.afterClose!(ENDED);
    expect(t.rebase.handHostConflict).toHaveBeenCalledWith(KEY, HOST_TEXT);
    expect(t.rebase.rebase).not.toHaveBeenCalled();
    expect([t.run.status, t.run.currentStep]).toEqual(['waiting', 'implement']);
  });

  it('rebases when history holds only the old project@sha entry', async () => {
    const t = setup({});
    t.store.set(ARTIFACTS.pipelineRebases.kind, JSON.stringify([`group/demo@${t.head}`]));
    const result = await t.call();
    await result.afterClose!(ENDED);
    expect(t.rebase.rebase).toHaveBeenCalled();
    expect(t.recorded()).toEqual([`group/demo@${t.head}`, `group/demo@${t.head}@${TIPS}`]);
  });

  it('waits while the epic parts run, counting no try and recording no key', async () => {
    const t = setup({ idle: false });
    const result = await t.call();
    expect(result.route).toEqual(
      expect.objectContaining({
        reason: `the epic's parts are still running; next try at ${RETRY_AT}`,
        code: ERROR_CODES.CI_NOT_STARTED,
        retryAt: RETRY_AT,
      }),
    );
    expect(t.run.attemptsPipeline).toBe(0);
    expect(t.events.recordLoop).not.toHaveBeenCalled();
    expect(t.rebase.baseTips).not.toHaveBeenCalled();
    expect(t.recorded()).toEqual([]);
  });

  it('keeps the run waiting, not blocked, when the move is refused while parts run', async () => {
    const t = setup({});
    t.rebase.rebase.mockRejectedValue(new ConflictException(ERROR_CODES.SUBTASKS_RUNNING));
    const result = await t.call();
    await result.afterClose!(ENDED);
    expect(t.run.status).toBe('waiting');
    expect(reasonOf(t.run)).toEqual(expect.objectContaining({ code: ERROR_CODES.CI_NOT_STARTED, retryAt: RETRY_AT }));
    expect(t.recorded()).toEqual([]);
  });

  it('records the key when the move ends in a conflict block, not on an outage or a Stop', async () => {
    const blocked = setup({});
    blocked.rebase.rebase.mockRejectedValue(new Error('fetch failed'));
    await (
      await blocked.call()
    ).afterClose!(ENDED);
    expect(blocked.run.status).toBe('blocked');
    expect(reasonOf(blocked.run).code).toBe(ERROR_CODES.REBASE_CONFLICT);
    expect(blocked.recorded()).toEqual([`group/demo@${blocked.head}@${TIPS}`]);

    const outage = setup({});
    outage.rebase.rebase.mockRejectedValue(new HostUnavailable('github', 'down', RETRY_AT));
    await (
      await outage.call()
    ).afterClose!(ENDED);
    expect(reasonOf(outage.run).code).toBe(ERROR_CODES.HOST_UNAVAILABLE);
    expect(outage.recorded()).toEqual([]);

    const stopped = setup({});
    const end = await (await stopped.call(true)).afterClose!(ENDED);
    expect(end.message).toBe('automatic rebase cancelled by Stop');
    expect(stopped.rebase.rebase).not.toHaveBeenCalled();
    expect(stopped.recorded()).toEqual([]);
  });

  it('waits with the next look when the host gives no code, as for GitHub mergeable null', async () => {
    const t = setup({ code: null });
    const result = await t.call();
    expect(result.route).toEqual(expect.objectContaining({ to: 'wait', code: ERROR_CODES.CI_NOT_STARTED }));
    expect((result.route as { reason: string }).reason).toContain('next look at');
    expect(t.rebase.rebase).not.toHaveBeenCalled();
  });

  it('stops at the limit and names each try, old entries without a tip', async () => {
    const t = setup({ attempts: 6, history: ['group/demo@abc123@demo@tip1', 'group/demo@old456'] });
    const result = await t.call();
    expect(result.route).toEqual(
      expect.objectContaining({
        to: 'block',
        reason: expect.stringContaining(
          'automatic rebase limit reached; tried: group/demo at abc123 onto demo@tip1; group/demo at old456',
        ) as string,
      }),
    );
    const none = await setup({ attempts: 6 }).call();
    expect((none.route as { reason: string }).reason).toContain('limit reached; tried: none');
  });

  it('stops when the worktree has changes', async () => {
    const t = setup({});
    writeFileSync(join(t.tree, 'manual.txt'), 'edit');
    const result = await t.call();
    expect(result.route).toEqual(
      expect.objectContaining({ to: 'block', reason: expect.stringContaining('working files changed') as string }),
    );
    expect(t.rebase.rebase).not.toHaveBeenCalled();
  });
});
