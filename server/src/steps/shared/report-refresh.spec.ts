import { runInStepScope } from '../../core/step-event-scope';
import type { StepEvent } from '../../contract/step-events';
import type { RunEntity } from '../../history/entities';
import { renderMergeRequest } from '../merge-request/merge-request-record';
import { REPORT_END, REPORT_START, reportOf, spliceReport } from './report-markers';
import { ReportRefresh } from './report-refresh';

const RUN = { id: 1, key: 'K-1', codeHost: 'gitlab', startedBy: null } as unknown as RunEntity;
const REQUIREMENTS = JSON.stringify({ prompt: 'Ship the field\n', tickets: [] });
const URL = 'https://gitlab.example/mr/9';

function stored(summary: string): string {
  return renderMergeRequest([{ project: 'group/demo', iid: 9, url: URL, draft: true, summary }]);
}

interface Setup {
  refresh: ReportRefresh;
  documents: Record<string, string>;
  find: jest.Mock;
  update: jest.Mock;
  put: jest.Mock;
}

function setup(report: string | null, hostBody: string, mergeRequest: string | null): Setup {
  const documents: Record<string, string> = { requirements: REQUIREMENTS };
  if (mergeRequest) {
    documents.merge_request = mergeRequest;
  }
  const put = jest.fn(async (_run: RunEntity, kind: string, body: string) => {
    documents[kind] = body;
  });
  const find = jest.fn(async () => ({
    record: { project: 'group/demo', iid: 9, url: URL, summary: hostBody, draft: true },
    httpCalls: [],
  }));
  const update = jest.fn(async () => ({ httpCalls: [] }));
  const refresh = new ReportRefresh(
    { findRun: async () => RUN } as never,
    { latestBody: async (_key: string, kind: string) => documents[kind] ?? null, putDocument: put } as never,
    { render: async () => report } as never,
    { hostFor: async () => ({ findMergeRequest: find, updateMergeRequest: update }) } as never,
  );
  return { refresh, documents, find, update, put };
}

describe('ReportRefresh', () => {
  it('makes no host call when the report did not change', async () => {
    const body = spliceReport('', 'same report');
    const { refresh, find, update } = setup('same report', body, stored(body));
    await refresh.refresh(RUN);
    expect(find).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('does nothing for a run without a merge request or without a report', async () => {
    const none = setup('report', '', null);
    await none.refresh.refresh(RUN);
    const bare = setup(null, '', stored('text'));
    await bare.refresh.refresh(RUN);
    expect(none.find).not.toHaveBeenCalled();
    expect(bare.find).not.toHaveBeenCalled();
  });

  it('updates the body and the stored document, and keeps the flaky lines after the end marker', async () => {
    const hostBody = `Top\n\n${spliceReport('', 'old report')}\n\nflaky: a > b`;
    const { refresh, documents, update } = setup('new report', hostBody, stored(spliceReport('', 'old report')));
    await refresh.refresh(RUN);
    const sent = `Top\n\n${REPORT_START}\nnew report\n${REPORT_END}\n\nflaky: a > b`;
    expect(update).toHaveBeenCalledWith('group/demo', 9, sent);
    expect(documents.merge_request).toContain(sent);
    expect(reportOf(documents.merge_request ?? '')).toBe('new report');
  });

  it('records a failed activity and leaves the stored document as it was', async () => {
    const before = stored(spliceReport('', 'old report'));
    const { refresh, documents, update } = setup('new report', spliceReport('', 'old report'), before);
    update.mockRejectedValue(new Error('HTTP 503'));
    const events: StepEvent[] = [];
    const scope = {
      runId: 1,
      attemptId: 'a',
      step: 'pipeline',
      root: '/',
      clock: { now: () => 0, iso: () => '2026-11-16T10:00:00.000Z' },
      sink: async (event: StepEvent) => {
        events.push(event);
      },
    } as const;
    await runInStepScope(scope as never, 0, () => refresh.refresh(RUN));
    const finished = events.find((event) => event.kind === 'activity.finished');
    expect(finished).toMatchObject({ title: 'Update the merge request report', failed: true });
    expect(documents.merge_request).toBe(before);
  });
});
