import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { duration } from '../../../../lib/format';
import { visitView } from '../../../../test/fixtures';
import { QueryWrapper } from '../../../../test/query-wrapper';
import { expectNoRawJson } from '../../../../test/raw-json';
import { stepEvent } from '../../../../test/step-events';
import { StepDocuments } from './step-documents';

const checks = [
  { name: 'requirements', decision: 'decision: ok', body: 'all met' },
  { name: 'security', decision: 'decision: return', body: 'token leaked' },
];

function documents(overrides: Partial<ComponentProps<typeof StepDocuments>> = {}) {
  const props = {
    shownChecks: checks,
    check: null,
    setCheck: vi.fn(),
    visit: visitView(),
    logs: '',
    document: '',
    runKey: 'run-1',
    events: [],
    issues: new Map(),
    ...overrides,
  };
  render(<StepDocuments {...props} />, { wrapper: QueryWrapper });
  return props;
}

describe('StepDocuments', () => {
  it('selects a check by its name when its button is clicked', async () => {
    const user = userEvent.setup();
    const props = documents();

    await user.click(screen.getByRole('button', { name: 'requirements ok' }));
    expect(props.setCheck).toHaveBeenLastCalledWith('requirements');

    await user.click(screen.getByRole('button', { name: 'security return' }));
    expect(props.setCheck).toHaveBeenLastCalledWith('security');
  });

  it('shows the log text and the markdown document', () => {
    documents({ logs: 'starting the agent', document: '# Report heading' });

    expect(screen.getByText('starting the agent')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Report heading' })).toBeInTheDocument();
  });

  it('shows each exchange with its model and duration', () => {
    documents({
      visit: visitView({
        exchanges: [{ model: 'claude-opus', durationMs: 2500, request: 'list files', response: 'three files' }],
      }),
    });

    expect(screen.getByText(`claude-opus · ${duration(2500)}`)).toBeInTheDocument();
  });

  it('puts the log of a visit with no events in a card marked legacy', () => {
    documents({ logs: 'starting the agent' });

    expect(screen.getByText('legacy: details not recorded')).toBeInTheDocument();
    expect(screen.getByText('starting the agent')).toBeInTheDocument();
  });

  it('shows the transcript, the live log and the exchanges of an agent step when events were recorded', () => {
    documents({
      logs: 'starting the agent',
      events: [stepEvent(1, { kind: 'artifact.produced', artifactKind: 'diff', documentId: 4, summary: 'a diff' })],
      visit: visitView({
        exchanges: [{ model: 'claude-opus', durationMs: 2500, request: 'list files', response: 'three files' }],
      }),
    });

    expect(screen.getByText('a diff')).toBeInTheDocument();
    expect(screen.queryByText('legacy: details not recorded')).not.toBeInTheDocument();
    expect(screen.getByText('starting the agent')).toBeInTheDocument();
    expect(screen.getByText(`claude-opus · ${duration(2500)}`)).toBeInTheDocument();
  });

  it('shows neither the transcript nor the legacy log while the events load', () => {
    documents({ logs: 'starting the agent', events: null });

    expect(screen.queryByText('legacy: details not recorded')).not.toBeInTheDocument();
    expect(screen.queryByText('starting the agent')).not.toBeInTheDocument();
  });

  describe('a plan visit', () => {
    const requirements = JSON.stringify({
      prompt: 'Ship the field',
      plan: { name: '', overview: '', items: ['first item'], decision: null },
    });
    const streamLine = '{"type":"system","subtype":"init","session_id":"s1"}';
    const stored = [
      { kind: 'requirements', attempt: 1, body: requirements, createdAt: 't' },
      { kind: 'log', attempt: 1, body: streamLine, createdAt: 't' },
    ];
    const recorded = [
      stepEvent(1, {
        kind: 'artifact.produced',
        artifactKind: 'requirements',
        documentId: 1,
        summary: '1 checklist items: first item',
      }),
      stepEvent(2, { kind: 'artifact.produced', artifactKind: 'log', documentId: 2, summary: streamLine }),
      stepEvent(3, {
        kind: 'handoff.sent',
        handoffId: 3,
        targetStep: 'implement',
        artifactKinds: ['requirements', 'log'],
        issueIds: [],
        summaries: ['1 checklist items: first item', streamLine],
      }),
    ];

    it('shows the cards of its events and no raw document, no log artifact and no stream line', () => {
      documents({ shownChecks: [], visit: visitView({ documents: stored }), events: recorded });

      expect(screen.getAllByText('1 checklist items: first item')).toHaveLength(2);
      expect(screen.getAllByText('artifact', { exact: false }).length).toBeGreaterThan(0);
      expect(screen.queryByText(/"subtype"/)).not.toBeInTheDocument();
      expect(screen.queryByText('Ship the field')).not.toBeInTheDocument();
      expectNoRawJson(document.body);
    });

    it('shows each document of a visit with no events once under its kind', () => {
      documents({
        shownChecks: [],
        visit: visitView({
          documents: [...stored, { kind: 'plan_notes', attempt: 1, body: '# Notes', createdAt: 't' }],
        }),
        logs: streamLine,
      });

      expect(screen.getAllByText('requirements')).toHaveLength(1);
      expect(screen.getAllByText('plan_notes')).toHaveLength(1);
      expect(screen.getAllByText('Ship the field')).toHaveLength(1);
      expect(screen.getByRole('heading', { name: 'Notes' })).toBeInTheDocument();
      expect(within(document.body).queryAllByText(/"subtype"/)).toEqual([]);
      expectNoRawJson(document.body);
    });
  });

  describe('the checks window', () => {
    const at = (second: number) => `2026-01-01T00:00:0${second}.000Z`;
    const rows = [0, 1].map((index) => ({
      attempt: 'att-1',
      index,
      repo: 'api',
      command: `npm run step${index}`,
      name: `step ${index}`,
      status: 'passed' as const,
      startedAt: at(0),
      endedAt: at(2),
      exitCode: 0,
    }));
    const finished = visitView({
      attemptId: 'att-1',
      status: 'done',
      samples: [
        { at: at(0), cpu: 10, memory: 100, source: '0' },
        { at: at(1), cpu: 20, memory: 200, source: '1' },
      ],
      documents: [
        {
          kind: 'checks',
          attempt: 1,
          body: JSON.stringify({ repo: 'api', command: 'npm test', exitCode: 0, tail: '\u001b[32mok\u001b[0m' }),
          createdAt: 't',
        },
      ],
    });
    const serverChecks = stepEvent(
      1,
      { kind: 'activity.started', spanId: 'act', title: 'Server checks' },
      { step: 'checks' },
    );

    it('draws one total chart, then the commands, then the transcript', () => {
      documents({ shownChecks: [], visit: finished, commands: rows, events: [serverChecks] });

      const chart = screen.getByRole('img', { name: 'CPU and memory' });
      const list = screen.getByRole('list', { name: 'Check commands' });
      const transcript = screen.getByTestId('transcript-feed');
      expect(screen.getAllByRole('img', { name: 'CPU and memory' })).toHaveLength(1);
      expect(screen.queryByText(/^command 0/)).toBeNull();
      expect(chart.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(list.compareDocumentPosition(transcript) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('keeps no raw result document and no Server checks card in a finished visit', () => {
      documents({ shownChecks: [], visit: finished, commands: rows, events: [] });
      expect(screen.queryByText(/^\{"/)).toBeNull();
      expect(document.body.textContent).not.toContain('\u001b');
      expect(screen.queryByText('checks')).toBeNull();
    });

    it('shows no Server checks card, also when its activity never finished', () => {
      documents({ shownChecks: [], visit: finished, commands: rows, events: [serverChecks] });

      expect(screen.queryByText('Server checks')).toBeNull();
    });
  });
});
