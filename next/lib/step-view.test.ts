import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decisionLine, fileView, reportAgrees, shownStatus, stepText, tokenUsage, usage, visitChecks, withFileUsage, withLog } from './step-view.ts';
import type { StepView } from './types.ts';

const doneLog = 'decision: ok\n{"type":"result"}\n';
const waitingLog = 'decision: return\n{"type":"result"}\n';
const failedLog = '{"type":"result"}\n';
const usageLog = '{"usage":{"inputTokens":10,"outputTokens":4}}';

function visit(partial: Partial<StepView['visits'][number]> = {}): StepView['visits'][number] {
  return {
    id: 1,
    attempt: 1,
    status: 'running',
    model: null,
    mode: null,
    durationMs: 5,
    tokensIn: 0,
    tokensOut: 0,
    usd: 0,
    cpuAvg: 0,
    cpuPeak: 0,
    memAvg: 0,
    memPeak: 0,
    killReason: null,
    decision: null,
    documents: [],
    exchanges: [],
    samples: [],
    ...partial,
  };
}

function assertNow(iso: string, before: number, after: number): void {
  const time = Date.parse(iso);
  assert.equal(Number.isNaN(time), false);
  assert.equal(time >= before && time <= after, true);
}

describe('decisionLine', () => {
  it('keeps the last decision line', () => {
    assert.equal(decisionLine('a\n decision: ok \nnope\ndecision: return'), 'decision: return');
    assert.equal(decisionLine('decision:ok'), 'decision:ok');
    assert.equal(decisionLine('none'), null);
  });
});

describe('reportAgrees', () => {
  it('accepts a missing decision and rejects a mismatch', () => {
    assert.equal(reportAgrees(undefined, 'decision: ok'), false);
    assert.equal(reportAgrees('', 'decision: ok'), false);
    assert.equal(reportAgrees('hello', null), true);
    assert.equal(reportAgrees('hello', 'decision: ok'), true);
    assert.equal(reportAgrees('decision: ok', null), true);
    assert.equal(reportAgrees('decision: ok', 'decision: ok'), true);
    assert.equal(reportAgrees('decision: ok', 'decision: return'), false);
  });
});

describe('shownStatus', () => {
  it('maps review decisions and folds a waiting step that is not the live wait', () => {
    assert.equal(shownStatus('running', true, 'failed', 'code-review', 'decision: ok'), 'running');
    assert.equal(shownStatus('idle', true, 'failed', 'code-review', 'decision: ok'), 'done');
    assert.equal(shownStatus('idle', true, 'failed', 'code-review', 'decision: return'), 'waiting');
    assert.equal(shownStatus('idle', true, undefined, 'code-review', null), 'idle');
    assert.equal(shownStatus('waiting', true, 'failed', 'code-review-quality', 'decision: ok'), 'done');
    assert.equal(shownStatus('waiting', true, undefined, 'code-review-quality', null), 'waiting');
    assert.equal(shownStatus('failed', false, 'running', 'code-review-quality', null), 'failed');
    assert.equal(shownStatus('waiting', true, 'waiting', 'implement', null), 'waiting');
    assert.equal(shownStatus('waiting', false, 'waiting', 'implement', null), 'done');
    assert.equal(shownStatus('waiting', true, 'failed', 'implement', null), 'done');
    assert.equal(shownStatus('blocked', true, 'blocked', 'implement', null), 'blocked');
  });
});

describe('visitChecks', () => {
  it('reads angle documents and skips the report, residual, and log', () => {
    assert.deepEqual(visitChecks(undefined), []);
    assert.deepEqual(
      visitChecks(
        visit({
          documents: [
            { kind: 'review_quality', body: 'note\ndecision: ok\n', attempt: 1, createdAt: 't' },
            { kind: 'review_report', body: 'decision: return', attempt: 1, createdAt: 't' },
            { kind: 'review_residual', body: 'left', attempt: 1, createdAt: 't' },
            { kind: 'log', body: 'log', attempt: 1, createdAt: 't' },
            { kind: 'review_security', body: 'plain', attempt: 1, createdAt: 't' },
          ],
        }),
      ),
      [
        { name: 'quality', decision: 'decision: ok', body: 'note\ndecision: ok\n' },
        { name: 'security', decision: null, body: 'plain' },
      ],
    );
  });
});

describe('stepText', () => {
  const stored = visit({
    decision: 'decision: return',
    documents: [
      { kind: 'log', attempt: 1, body: 'L1', createdAt: 't' },
      { kind: 'log', attempt: 1, body: 'L2', createdAt: 't' },
      { kind: 'review_report', attempt: 1, body: 'report\ndecision: ok', createdAt: 't' },
      { kind: 'plan', attempt: 1, body: 'plan', createdAt: 't' },
      { kind: 'note', attempt: 1, body: '', createdAt: 't' },
    ],
  });

  it('joins logs and prefers a selected check, then an agreeing report, then angle notes, then other documents', () => {
    assert.deepEqual(stepText('implement', undefined, undefined, []), { logs: '', document: '' });
    assert.deepEqual(stepText('code-review', stored, { body: 'picked' }, [{ body: 'angle' }]), { logs: '', document: 'picked' });
    assert.deepEqual(stepText('code-review', stored, undefined, []), { logs: 'L1\nL2', document: 'plan' });
    assert.deepEqual(stepText('code-review', { ...stored, decision: 'decision: ok' }, undefined, [{ body: 'angle' }]), {
      logs: 'L1\nL2',
      document: 'report\ndecision: ok',
    });
    assert.deepEqual(stepText('implement', visit({ documents: [] }), undefined, [{ body: 'one' }, { body: '' }, { body: 'two' }]), {
      logs: '',
      document: 'one\n\ntwo',
    });
    assert.deepEqual(stepText('implement', stored, undefined, []), { logs: 'L1\nL2', document: 'plan' });
  });
});

describe('tokenUsage', () => {
  it('prefers a positive reported count and otherwise the log', () => {
    assert.deepEqual(tokenUsage('plain'), {});
    assert.deepEqual(tokenUsage(usageLog), { tokensIn: 10, tokensOut: 4, usd: 0 });
    assert.deepEqual(tokenUsage('plain', { tokensIn: 0, tokensOut: 0, usd: 1 }), { tokensIn: 0, tokensOut: 0, usd: 1 });
    assert.deepEqual(tokenUsage(usageLog, { tokensIn: 0, tokensOut: 9, usd: 1.25 }), { tokensIn: 10, tokensOut: 9, usd: 1.25 });
    assert.deepEqual(tokenUsage(usageLog, { tokensIn: 7, tokensOut: 0, usd: 2 }), { tokensIn: 7, tokensOut: 4, usd: 2 });
  });
});

describe('usage', () => {
  it('averages samples and rounds memory', () => {
    assert.deepEqual(usage([]), { cpuAvg: 0, cpuPeak: 0, memAvg: 0, memPeak: 0 });
    assert.deepEqual(usage([{ cpu: 1, memory: 10 }, { cpu: 2, memory: 11 }]), { cpuAvg: 1.5, cpuPeak: 2, memAvg: 11, memPeak: 11 });
  });
});

describe('fileView', () => {
  it('builds a running visit from an empty log and a finished visit from a decision', () => {
    const before = Date.now();
    const empty = fileView('code-review-quality', '');
    const after = Date.now();
    assert.equal(empty.step, 'code-review-quality');
    assert.deepEqual(empty.checks, []);
    assert.equal(empty.visits[0]?.status, 'running');
    assert.equal(empty.visits[0]?.id, -1);
    assert.equal(empty.visits[0]?.attempt, 1);
    assert.equal(empty.visits[0]?.mode, 'agent');
    assert.equal(empty.visits[0]?.documents[0]?.body, 'waiting for output\n');
    assertNow(empty.visits[0]?.documents[0]?.createdAt ?? '', before, after);
    assert.equal(fileView('code-review-quality', doneLog).visits[0]?.status, 'done');
    assert.equal(fileView('code-review-quality', doneLog).visits[0]?.documents[0]?.body, doneLog);
  });
});

describe('withLog', () => {
  it('returns the same view when there is no visit or a finished chip already has samples', () => {
    const empty = { step: 'implement', checks: [], visits: [] };
    assert.equal(withLog(empty, 'body', []), empty);
    const sampled = { step: 'code-review-quality', checks: [], visits: [visit({ status: 'done', samples: [{ at: 't', cpu: 1, memory: 2 }] })] };
    assert.equal(withLog(sampled, doneLog, [{ at: 'n', cpu: 9, memory: 9 }]), sampled);
    const quiet = { step: 'code-review-quality', checks: [], visits: [visit({ status: 'done', samples: [] })] };
    assert.equal(withLog(quiet, doneLog, []), quiet);
  });

  it('stores samples on a finished chip that had none', () => {
    const current = visit({ status: 'failed', samples: [], tokensIn: 5 });
    const samples = [{ at: 't', cpu: 4, memory: 50 }];
    const next = withLog({ step: 'code-review-quality', checks: [], visits: [current] }, doneLog, samples);
    assert.equal(next.visits[0]?.status, 'failed');
    assert.equal(next.visits[0]?.tokensIn, 5);
    assert.deepEqual(next.visits[0]?.samples, samples);
    assert.equal(next.visits[0]?.cpuAvg, 4);
    assert.equal(next.visits[0]?.cpuPeak, 4);
    assert.equal(next.visits[0]?.memAvg, 50);
    assert.equal(next.visits[0]?.memPeak, 50);
  });

  it('opens the next attempt when a finished visit is still receiving a log', () => {
    const current = visit({
      status: 'done',
      attempt: 4,
      tokensIn: 3,
      tokensOut: 2,
      usd: 1,
      documents: [{ kind: 'log', attempt: 4, body: 'old', createdAt: 't' }],
    });
    const before = Date.now();
    const next = withLog({ step: 'implement', checks: [], visits: [current] }, 'still going', [{ at: 't', cpu: 2, memory: 10 }]);
    const after = Date.now();
    const opened = next.visits[1];
    assert.equal(next.visits[0], current);
    assert.equal(opened?.id, -1);
    assert.equal(opened?.attempt, 5);
    assert.equal(opened?.status, 'running');
    assert.equal(opened?.durationMs, 0);
    assert.equal(opened?.killReason, null);
    assert.equal(opened?.decision, null);
    assert.deepEqual(opened?.exchanges, []);
    assert.equal(opened?.tokensIn, 0);
    assert.equal(opened?.tokensOut, 0);
    assert.equal(opened?.usd, 0);
    assert.equal(opened?.cpuAvg, 2);
    assert.equal(opened?.memAvg, 10);
    assert.equal(opened?.documents[0]?.body, 'still going');
    assert.equal(opened?.documents[0]?.attempt, 5);
    assertNow(opened?.documents[0]?.createdAt ?? '', before, after);
  });

  it('replaces a running log, adds one when missing, and applies a live decision', () => {
    const logged = visit({
      status: 'running',
      tokensIn: 1,
      documents: [{ kind: 'log', attempt: 1, body: 'old', createdAt: '2020-01-01T00:00:00.000Z' }],
    });
    const replaced = withLog({ step: 'implement', checks: [], visits: [logged] }, 'new', []);
    assert.equal(replaced.visits[0]?.documents[0]?.body, 'new');
    assert.equal(replaced.visits[0]?.documents[0]?.createdAt, '2020-01-01T00:00:00.000Z');
    assert.equal(replaced.visits[0]?.status, 'running');
    assert.equal(replaced.visits[0]?.tokensIn, 1);

    const noted = visit({
      status: 'running',
      attempt: 2,
      documents: [{ kind: 'note', attempt: 2, body: 'n', createdAt: '2020-01-01T00:00:00.000Z' }],
    });
    const before = Date.now();
    const added = withLog({ step: 'implement', checks: [], visits: [noted] }, 'live', []);
    const after = Date.now();
    assert.equal(added.visits[0]?.documents[0]?.body, 'n');
    assert.equal(added.visits[0]?.documents[1]?.kind, 'log');
    assert.equal(added.visits[0]?.documents[1]?.attempt, 2);
    assert.equal(added.visits[0]?.documents[1]?.body, 'live');
    assertNow(added.visits[0]?.documents[1]?.createdAt ?? '', before, after);

    const passed = withLog({ step: 'code-review', checks: [], visits: [visit({ status: 'running', decision: 'decision: ok' })] }, waitingLog, []);
    assert.equal(passed.visits[0]?.status, 'done');
    const failed = withLog({ step: 'code-review', checks: [], visits: [visit({ status: 'running' })] }, failedLog, []);
    assert.equal(failed.visits[0]?.status, 'failed');
    const counted = withLog({ step: 'implement', checks: [], visits: [visit({ status: 'running' })] }, 'plain', [], { tokensIn: 8, tokensOut: 1, usd: 0.4 });
    assert.equal(counted.visits[0]?.tokensIn, 8);
    assert.equal(counted.visits[0]?.tokensOut, 1);
    assert.equal(counted.visits[0]?.usd, 0.4);
  });
});

describe('withFileUsage', () => {
  it('leaves a view with no log and copies token counts from a finished log', () => {
    const bare = { step: 's', checks: [], visits: [visit({ status: 'done' })] };
    assert.equal(withFileUsage(bare), bare);
    const blank = { step: 's', checks: [], visits: [visit({ status: 'done', documents: [{ kind: 'log', attempt: 1, body: '', createdAt: 't' }] })] };
    assert.equal(withFileUsage(blank), blank);
    const plain = { step: 's', checks: [], visits: [visit({ status: 'done', documents: [{ kind: 'log', attempt: 1, body: 'plain', createdAt: 't' }] })] };
    assert.equal(withFileUsage(plain), plain);
    const current = visit({ status: 'done', documents: [{ kind: 'log', attempt: 1, body: usageLog, createdAt: 't' }] });
    const next = withFileUsage({ step: 's', checks: [], visits: [current] });
    assert.equal(next.visits[0]?.tokensIn, 10);
    assert.equal(next.visits[0]?.tokensOut, 4);
    assert.equal(next.visits[0]?.usd, 0);
    assert.equal(next.visits[0]?.documents[0], current.documents[0]);
    const running = withFileUsage({
      step: 's',
      checks: [],
      visits: [visit({ status: 'running', documents: [{ kind: 'log', attempt: 1, body: usageLog, createdAt: 't' }] })],
    });
    assert.equal(running.visits[0]?.tokensIn, 10);
    assert.equal(running.visits[0]?.tokensOut, 4);
  });
});
