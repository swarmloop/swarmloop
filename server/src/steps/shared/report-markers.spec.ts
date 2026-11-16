import { REPORT_END, REPORT_START, reportOf, spliceReport } from './report-markers';

describe('report markers', () => {
  it('keeps the text before and after the markers byte-identical', () => {
    const before = '## Template\r\n\r\n- [ ] tested  \n\nA person wrote this.\n\n';
    const after = '\n\nflaky: suite > case\nflaky: other\n';
    const body = `${before}${REPORT_START}\nold report\n${REPORT_END}${after}`;
    const next = spliceReport(body, 'new report\n');
    expect(next).toBe(`${before}${REPORT_START}\nnew report\n${REPORT_END}${after}`);
  });

  it('gives an unmarked old body the marked report and keeps its flaky lines', () => {
    expect(spliceReport('## What changed\nold text', 'new')).toBe(`${REPORT_START}\nnew\n${REPORT_END}`);
    expect(spliceReport('old text\n\nflaky: a\nflaky: b', 'new')).toBe(
      `${REPORT_START}\nnew\n${REPORT_END}\n\nflaky: a\nflaky: b`,
    );
  });

  it('marks the report of an empty body', () => {
    expect(spliceReport('', 'report')).toBe(`${REPORT_START}\nreport\n${REPORT_END}`);
  });

  it('reads the marked part, or null', () => {
    expect(reportOf(`top\n${REPORT_START}\nthe report\n${REPORT_END}\nbottom`)).toBe('the report');
    expect(reportOf('no markers here')).toBeNull();
    expect(reportOf(`${REPORT_START} never closed`)).toBeNull();
  });
});
