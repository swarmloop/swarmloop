import { CODE_REVIEWERS } from '../../contract/steps';
import { readResult } from '../read-result';
import { block } from '../result.spec-helpers';
import { reviewReportCodec } from '../review-report-codec';
import { isLegacyReport, legacyReviewReport, reviewReport } from './review-report';

const REPORT = {
  line: 'The field ships.',
  done: ['one', 'two', 'three', 'four', 'five'],
  worthALook: [
    { place: 'a.ts', reason: 'one' },
    { place: 'b.ts', reason: 'two' },
    { place: 'c.ts', reason: 'three' },
  ],
  notes: Object.fromEntries(CODE_REVIEWERS.map((name) => [name, 'ok'])),
  risk: 'medium',
  riskReason: 'a new path',
};

describe('review report definition', () => {
  it('accepts five done items and three places to look', () => {
    expect(readResult(reviewReport, block(REPORT))).toEqual({ ok: true, value: REPORT });
  });

  it('refuses a done list over five items', () => {
    const read = readResult(reviewReport, block({ ...REPORT, done: [...REPORT.done, 'six'] }));
    expect(read.ok === false && read.errors[0]).toContain('done');
  });

  it('refuses more than three places to look', () => {
    const read = readResult(
      reviewReport,
      block({ ...REPORT, worthALook: [...REPORT.worthALook, REPORT.worthALook[0]] }),
    );
    expect(read.ok === false && read.errors[0]).toContain('worthALook');
  });

  it('refuses a report that leaves one of the three reviewers out of its notes', () => {
    const { behavior: _left, ...notes } = REPORT.notes;
    const read = readResult(reviewReport, block({ ...REPORT, notes }));
    expect(read.ok === false && read.errors[0]).toContain('notes.behavior');
  });

  it('reads the report of a run reviewed by the retired five through its stored shape', () => {
    const retired = ['requirements', 'quality', 'regressions', 'security', 'performance'];
    const stored = { ...REPORT, notes: Object.fromEntries(retired.map((name) => [name, 'ok'])) };
    expect(readResult(reviewReport, block(stored)).ok).toBe(false);
    expect(reviewReportCodec.parse(JSON.stringify(stored))).toEqual(stored);
    expect(reviewReportCodec.parse(JSON.stringify(REPORT))).toEqual(REPORT);
  });

  it('refuses a stored report with a note of a name that was never a reviewer', () => {
    const stored = { ...REPORT, notes: { ...REPORT.notes, style: 'ok' } };
    expect(() => reviewReportCodec.parse(JSON.stringify(stored))).toThrow('notes');
  });

  it('refuses a risk that is not low, medium or high', () => {
    const read = readResult(reviewReport, block({ ...REPORT, risk: 'huge' }));
    expect(read.ok === false && read.errors[0]).toContain('risk');
  });

  it('reads the old shape by its own schema and tells it apart', () => {
    const legacy = { whatChanged: 'Parser fixed.', codeReview: 'All ok.' };
    expect(readResult(legacyReviewReport, block(legacy))).toEqual({ ok: true, value: legacy });
    expect(isLegacyReport(legacy)).toBe(true);
    expect(isLegacyReport(REPORT as never)).toBe(false);
  });
});
