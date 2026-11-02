import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { expandReviewPhases, keepOpenReviews, latestPhaseLabels, liveLogStep, markReviewFinished, markReviewLive, PHASES, pipelineStep, replaySelection, reviewChipName, stepLabel, withReport } from './phases.ts';

describe('liveLogStep', () => {
  it('keeps a per-repo implement log on implement, not implement-improve', () => {
    assert.equal(liveLogStep('implement-swarmloop', 'implement'), true);
    assert.equal(liveLogStep('implement-improve-swarmloop', 'implement'), false);
    assert.equal(liveLogStep('implement-improve-swarmloop', 'implement-improve'), true);
    assert.equal(liveLogStep('code-review-quality', 'code-review'), false);
    assert.equal(liveLogStep('code-review-quality', 'code-review-quality'), true);
    assert.equal(liveLogStep('code-review', 'code-review-quality'), false);
  });

  it('maps a reviewer chip back to code-review and expands the board', () => {
    assert.equal(pipelineStep('code-review-quality'), 'code-review');
    assert.equal(pipelineStep('implement'), 'implement');
    const expanded = expandReviewPhases([
      { phase: 'code review', steps: [{ name: 'code-review', status: 'running' }] },
    ]);
    assert.deepEqual(
      expanded[0]?.steps.map((step) => step.name),
      [
        'code-review-requirements',
        'code-review-quality',
        'code-review-regressions',
        'code-review-security',
        'code-review-performance',
      ],
    );
    const locked = replaySelection([...PHASES], [...PHASES], 'code-review-quality');
    assert.equal(locked.locked.includes('code-review'), true);
    const marked = markReviewFinished(expanded, 'code-review-quality', 'waiting');
    assert.equal(marked[0]?.steps.find((step) => step.name === 'code-review-quality')?.status, 'waiting');
    const passed = markReviewFinished(marked, 'code-review-quality', 'done');
    assert.equal(passed[0]?.steps.find((step) => step.name === 'code-review-quality')?.status, 'done');
    assert.equal(marked[0]?.steps.find((step) => step.name === 'code-review-security')?.status, 'running');
    const live = markReviewLive(marked, 'code-review-quality');
    assert.equal(live[0]?.steps.find((step) => step.name === 'code-review-quality')?.status, 'running');
    assert.equal(live[0]?.steps.find((step) => step.name === 'code-review-security')?.status, 'running');
    const failed = markReviewFinished(
      [{ phase: 'code review', steps: [{ name: 'code-review-security', status: 'failed', current: false }] }],
      'code-review-security',
      'done',
    );
    assert.equal(failed[0]?.steps[0]?.status, 'done');
    const kept = markReviewFinished(failed, 'code-review-security', 'failed');
    assert.equal(kept[0]?.steps[0]?.status, 'done');
  });

  it('keeps open review chips running when a snapshot says idle or failed', () => {
    assert.equal(reviewChipName('code-review-report'), 'code-review');
    assert.equal(reviewChipName('code-review-quality'), 'code-review-quality');
    const snapshot = [
      {
        phase: 'code review',
        steps: [
          { name: 'code-review-quality', status: 'idle', current: false, attempts: 2 },
          { name: 'code-review-security', status: 'failed', current: false, attempts: 1 },
          { name: 'code-review-requirements', status: 'done', current: false, attempts: 1 },
          { name: 'code-review-regressions', status: 'waiting', current: false, attempts: 1 },
          { name: 'code-review-performance', status: 'idle', current: false, attempts: 0 },
          { name: 'code-review', status: 'failed', current: false, attempts: 3 },
          { name: 'implement', status: 'idle', current: false, attempts: 4 },
        ],
      },
    ];
    const open = new Set(['code-review-quality', 'code-review-security', 'code-review', 'implement']);
    const steps = keepOpenReviews(snapshot, open)[0]?.steps ?? [];
    assert.deepEqual(steps.find((step) => step.name === 'code-review-quality'), {
      name: 'code-review-quality',
      status: 'running',
      current: true,
      attempts: 2,
    });
    assert.deepEqual(steps.find((step) => step.name === 'code-review-security'), {
      name: 'code-review-security',
      status: 'running',
      current: true,
      attempts: 1,
    });
    assert.equal(steps.find((step) => step.name === 'code-review-requirements')?.status, 'done');
    assert.equal(steps.find((step) => step.name === 'code-review-regressions')?.status, 'waiting');
    assert.equal(steps.find((step) => step.name === 'code-review-performance')?.status, 'idle');
    assert.equal(steps.find((step) => step.name === 'code-review')?.status, 'running');
    assert.equal(steps.find((step) => step.name === 'code-review')?.current, true);
    assert.equal(steps.find((step) => step.name === 'code-review')?.attempts, 3);
    assert.equal(steps.find((step) => step.name === 'implement')?.status, 'idle');
  });
});

describe('latestPhaseLabels', () => {
  it('uses the last launch in phase order and keeps unknown ids after the five', () => {
    assert.deepEqual(
      latestPhaseLabels([
        { phases: ['requirements', 'code-review'] },
        { phases: ['ci', 'merge-request', 'requirements', 'custom', 'brainstorm', 'custom'] },
      ]),
      ['requirements', 'planning', 'ci', 'custom'],
    );
  });
});

describe('replaySelection', () => {
  it('locks the clicked phase and earlier phases the original flow included', () => {
    const choice = replaySelection([...PHASES], [...PHASES], 'code-review');
    assert.deepEqual(choice.locked, ['requirements', 'brainstorm', 'implementation', 'code-review']);
    assert.deepEqual(choice.selected, [...PHASES]);
  });

  it('leaves later phases editable and does not insert phases the original skipped', () => {
    const original = ['requirements', 'code-review'];
    const choice = replaySelection(original, original, 'code-review');
    assert.deepEqual(choice.locked, ['requirements', 'brainstorm', 'implementation', 'code-review']);
    assert.deepEqual(choice.selected, ['requirements', 'code-review']);
  });

  it('keeps phases after the click changeable', () => {
    const choice = replaySelection([...PHASES], ['requirements', 'brainstorm', 'implementation', 'code-review'], 'code-review');
    assert.deepEqual(choice.selected, ['requirements', 'brainstorm', 'implementation', 'code-review']);
    assert.equal(choice.locked.includes('ci'), false);
  });
});

describe('stepLabel', () => {
  it('names the report chip and strips the reviewer prefix', () => {
    assert.equal(stepLabel('code-review'), 'report');
    assert.equal(stepLabel('code-review-quality'), 'quality');
    assert.equal(stepLabel('implement'), 'implement');
  });
});

describe('withReport', () => {
  it('appends an idle report chip only when reviewers are present and the report is not', () => {
    const plain = [{ name: 'implement', status: 'done', current: false, attempts: 1 }];
    assert.equal(withReport(plain), plain);
    const reviewers = [{ name: 'code-review-quality', status: 'running', current: true, attempts: 2 }];
    assert.deepEqual(withReport(reviewers), [...reviewers, { name: 'code-review', status: 'idle', current: false, attempts: 0 }]);
    const both = [...reviewers, { name: 'code-review', status: 'idle', current: false, attempts: 3 }];
    assert.equal(withReport(both), both);
  });
});
